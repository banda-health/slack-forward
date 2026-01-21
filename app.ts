import { App } from '@slack/bolt';
import { GenericMessageEvent, RichTextBlock, RichTextText, SectionBlock, WebClient } from '@slack/web-api';
import Eris, { WebhookPayload } from 'eris';
import {
	associate,
	dissociate,
	getDiscordUserNameFromGitHubOrSlackUsername,
} from './usernames';

const discordBot = Eris(process.env.DISCORD_BOT_TOKEN || '', {
	getAllUsers: true,
	intents: ['guildMembers'],
});

const slackApp = new App({
	token: process.env.SLACK_BOT_TOKEN,
	signingSecret: process.env.SLACK_SIGNING_SECRET,
	socketMode: true,
	appToken: process.env.SLACK_APP_TOKEN,
	port: parseInt(process.env.PORT || '3000'),
});

const slackWeb = new WebClient(process.env.SLACK_BOT_TOKEN);

const debugLogging = process.argv.indexOf('-v') >= 0;

function log(message: string, pre: string, level = 0) {
	if (level === 0 || debugLogging) {
		console.log(`[${pre}]${'\t'}${message}`);
	}
}

type UserInfo = { username?: string; avatar_url?: string };
type SlackReplacementResult = {
	match: RegExpExecArray;
	username?: string | undefined;
};

const slack_profiles_cache: {
	[slackUserKey: string]: UserInfo;
} = {};

async function resolveSlackUserReplacement(
	match: RegExpExecArray
): Promise<SlackReplacementResult> {
	const profile = await fetchSlackProfile(match[1]);
	return {
		match: match,
		username: profile.username,
	};
}

async function replaceUsernames(bodyText: string[]) {
	const usernameRegex = /<@(.+?)>/g;

	const userMatches: RegExpExecArray[] = [];
	let match: RegExpExecArray | null | undefined;
	bodyText.forEach((text) => {
		while ((match = usernameRegex.exec(text))) {
			userMatches.push(match);
		}
	});
	// match is array of ["<@userid>", "userid"]
	// We want to map to array of {match: ["<@userid>", "userid"], name: "user name"}

	let matchPromises: Promise<SlackReplacementResult>[] = [];
	for (let userMatch of userMatches) {
		matchPromises.push(resolveSlackUserReplacement(userMatch));
	}
	const userReplacements = await Promise.all(matchPromises);
	log(`replacements: ${JSON.stringify(userReplacements, null, 3)}`, 'slack', 3);
	for (let replacement of userReplacements) {
		bodyText = bodyText.map(
			(text) =>
			(text = text.replace(
				replacement.match[0],
				`<@${getDiscordUserNameFromGitHubOrSlackUsername(
					replacement.username || ''
				)}>`
			))
		);
	}

	// Now let's cycle through and get the user's that haven't been @'d yet in Waiting on
	bodyText = bodyText.map((text) => {
		if (!text.includes('Waiting on')) {
			return text;
		}
		let prInfoParts = text.split('Waiting on');
		let discordReviewers = prInfoParts[1];
		discordReviewers = prInfoParts[1]
			.replaceAll('_', '')
			.split(',')
			.map((discordOrGitHubOrSlackUsername) =>
				discordOrGitHubOrSlackUsername.trim()
			)
			.filter(
				(discordOrGitHubOrSlackUsername) =>
					!discordOrGitHubOrSlackUsername.includes('@')
			)
			.reduce(
				(discordReviewerString, gitHubOrSlackUsername) =>
					discordReviewerString.replace(
						gitHubOrSlackUsername,
						`<@${getDiscordUserNameFromGitHubOrSlackUsername(
							gitHubOrSlackUsername
						)}>`
					),
				discordReviewers
			);

		return `${prInfoParts[0]}Waiting on${discordReviewers}`;
	});

	return bodyText;
}

/**
 * Take the Slack message and transform it into something to post to Discord
 * @param slackMessage The message coming from slack
 * Here's the format for the slack message (the PRs are repeated for as many open in the repository):
 * ```
 * *Pending review on ORGANIZATION/REPOSITORY* - <REMINDER_URL|Manage reminder>
 * [#PR_NUMBER] <PR_URL|PR_LABEL> (_PR_AUTHOR_)
 * _STALENESS · AGE ·_ Waiting on _ COMMA_DELIMITED_REVIEWER_LIST_
 * ```
 * @returns A payload to send to Discord
 */
async function constructDiscordEmbedPayload(
	slackMessage: GenericMessageEvent
): Promise<WebhookPayload> {
	const channelRegex = /<#(?:.+?)\|([a-z0-9_-]{1,})>/g;
	const hyperlinkRegex = /<([^\|>]+)\|([^>]+)>/g;

	// channel names can't contain [&<>]
	let title = '';
	let description = '';
	if (slackMessage.blocks?.[0]?.type === 'rich_text') {
		let elements = (slackMessage.blocks?.[0] as RichTextBlock)?.elements?.[0]?.elements;
		// If the first message is a text block, use it as the title
		if (elements[0]?.type === 'text') {
			title = (elements[0] as RichTextText).text;
			// Remove the title block
			elements.shift();
			// Remove the dash block
			elements.shift();
			// Remove the manage reminder block
			elements.shift();
		}
		let areCheckingUserNames = false;
		description = elements.reduce((text, element) => {
			if (element.type === 'text') {
				if (element.text.includes('Waiting on')) {
					areCheckingUserNames = true;
				} else if (element.text.startsWith('\n')) {
					areCheckingUserNames = false;
				} else if (areCheckingUserNames) {
					return text + ' ' + element.text.split(', ').map((userName) => {
						return `<@${getDiscordUserNameFromGitHubOrSlackUsername(userName.trim())}>`
					}).join(', ');
				}
				if (element.text.includes('\n\n')) {
					return text + element.text.split('\n\n')[1];
				}
				if (element.style?.bold) {
					return text + `**${element.text}**`;
				}
				if (element.style?.italic) {
					return text + `*${element.text}*`;
				}
				if (element.style?.strike) {
					return text + `~~${element.text}~~`;
				}
				return text + element.text;
			} else if (element.type === 'link') {
				return text + `[${element.text}](${element.url})`;
			}
			return text;
		}, '');
	} else {
		let textToUse =
			slackMessage.blocks?.[0]?.type === 'section'
				? (slackMessage.blocks?.[0] as SectionBlock)?.text?.text
				: slackMessage.text;
		let cleanText = textToUse?.replace(channelRegex, '#$1') || '';

		// Update hyperlinks to match markdown mode
		// Collect all matches first to avoid issues with modifying string during iteration
		const hyperlinkMatches: RegExpExecArray[] = [];
		let match: RegExpExecArray | null | undefined;
		// Reset lastIndex to ensure we start from the beginning
		hyperlinkRegex.lastIndex = 0;
		while ((match = hyperlinkRegex.exec(cleanText))) {
			hyperlinkMatches.push(match);
		}

		// Process matches in reverse order to maintain correct indices when replacing
		for (let i = hyperlinkMatches.length - 1; i >= 0; i--) {
			match = hyperlinkMatches[i];
			const hyperlink = match[1];
			const linkText = match[2];
			// If this is the manage reminder, we don't want it in the Discord message
			if (linkText === 'Manage reminder') {
				cleanText = cleanText.replace(` - ${match[0]}`, '');
				continue;
			}
			cleanText = cleanText.replace(match[0], `[${linkText}](${hyperlink})`);
		}

		// Now that links are replaced and properly formatted, handle general clean-up
		// /g is important.
		cleanText = cleanText
			.replace(/&gt;/g, '>')
			.replace(/&lt;/g, '<')
			.replace(/&amp;/g, '&');

		// Split the message into it's two parts: the title and the body
		title = cleanText.split('*')[1];
		let bodyText = cleanText.split(/\r?\n/).filter((content) => !!content);
		// Remove the first element, since that's the title
		bodyText.shift();

		description = (await replaceUsernames(bodyText)).join('\n');
	}

	// Lastly we need to shift the PR link to include the [#PR_NUMBER] piece
	description = description.replaceAll(/(\[#\d+\]\s)\[/g, '[$1');

	return {
		embed: {
			title,
			description,
			color: 0x17a2b8,
		},
	};
}

async function fetchSlackProfile(user: string) {
	if (user in slack_profiles_cache) {
		log(
			`Profile '${slack_profiles_cache[user].username}' (${user}) already in cache`,
			'slack',
			3
		);
		return slack_profiles_cache[user];
	}
	// not in our cache
	log(`Fetching profile for uncached ID ${user}...`, 'slack', 3);
	const data = await slackWeb.users.profile.get({ user });
	let cached_profile = {
		username:
			data.profile?.display_name_normalized ||
			data.profile?.real_name_normalized,
		avatar_url: data.profile?.image_192,
	};
	log(`Profile received for ${cached_profile.username}`, 'slack', 3);
	slack_profiles_cache[user] = cached_profile;
	return cached_profile;
}

async function forwardGitHubScheduleReminderToDiscord(
	slackMessage: GenericMessageEvent
) {
	log(JSON.stringify(slackMessage, null, 3), 'slack', 3);
	try {
		const options = await constructDiscordEmbedPayload(slackMessage);
		discordBot.executeWebhook(
			process.env.DISCORD_HOOK_ID || '',
			process.env.DISCORD_HOOK_TOKEN || '',
			options
		);
	} catch (err) {
		log(`Error while forwarding to Discord: ${err}`, 'slack', 0);
	}
}

// Receive messages that have the following text in them
slackApp.message('Pending review on banda-health', async ({ message }) => {
	// Just forward the message to discord
	forwardGitHubScheduleReminderToDiscord(
		message as unknown as GenericMessageEvent
	);
});
// Handle associates/dissociate from Slack
slackApp.message('associate', async ({ message, say }) => {
	// message format = associate [slackOrGitHubUsername] [discordUsername]
	let contents =
		(message as unknown as GenericMessageEvent).text?.split(' ') || [];
	if (contents.length !== 3) {
		await say(
			'Please provide a message of the format `associate [slackOrGitHubUsername] [discordUsername]`'
		);
		return;
	}
	associate(contents[1].trim(), contents[2].trim());
});
slackApp.message('dissociate', async ({ message, say }) => {
	// message format = dissociate [slackOrGitHubUsername]
	let contents =
		(message as unknown as GenericMessageEvent).text?.split(' ') || [];
	if (contents.length !== 2) {
		await say(
			'Please provide a message of the format `dissociate [slackOrGitHubUsername]`'
		);
		return;
	}
	dissociate(contents[1].trim());
});

(async () => {
	discordBot.on('ready', () => {
		console.log('Listening for discord events.');
	});
	await Promise.all([slackApp.start(), discordBot.connect()]);
	console.log('⚡️ Bolt app is running!');
})();
