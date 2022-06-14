import { App, AppMentionEvent } from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import Eris, { WebhookPayload } from 'eris';

const discordBot = Eris(process.env.DISCORD_BOT_TOKEN || '', {
	getAllUsers: true,
	intents: ['guildMembers'],
});

const app = new App({
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
		username: profile?.username,
	};
}

async function constructDiscordEmbedPayload(
	slackMessage: AppMentionEvent
): Promise<WebhookPayload> {
	const channelRegex = /<#(?:.+?)\|([a-z0-9_-]{1,})>/g;
	const hyperlinkRegex = /<.*\|.*>/g;
	const usernameRegex = /<@(.+?)>/g;

	// channel names can't contain [&<>]
	let cleanText = slackMessage.text.replace(channelRegex, '#$1');

	const prNumber = cleanText.match(/#\[\d+\]/)?.[0];
	const author = cleanText.match(/\(_(.*)_\)/)?.[1];
	const ageInformation = cleanText.match(/_(.*·.*)·/)?.[1]?.trim();

	// Update hyperlinks to match markdown mode
	let match;
	let manageReminderUrl: string | undefined;
	let prText: string | undefined;
	let prLink: string | undefined;
	while ((match = hyperlinkRegex.exec(cleanText))) {
		const [hyperlink, linkText] = match[0]
			.replace('<', '')
			.replace('>', '')
			.split('|');
		if (linkText === 'Manage reminder') {
			manageReminderUrl = `[${linkText}](${hyperlink})`;
		} else {
			prText = linkText;
			prLink = hyperlink;
		}
		cleanText = cleanText.replace(match[0], `[${linkText}](${hyperlink})`);
	}

	const userMatches = [];
	// let match;
	// while ((match = usernameRegex.exec(cleanText)) != null) {
	// 	userMatches.push(match);
	// }
	// // Matches is array of ["<@userid>", "userid"]
	// // We want to map to array of {match: ["<@userid>", "userid"], name: "user name"}

	let matchPromises = await fetchGithubProfile('userMatch');
	// for (let userMatch of userMatches) {
	// 	matchPromises.push(fetchGithubProfile(userMatch));
	// }
	// const userReplacements = await Promise.all(matchPromises);
	// log(`replacements: ${JSON.stringify(userReplacements, null, 3)}`, 'slack', 3);
	// for (let replacement of matchPromises) {
	// 	cleanText = cleanText.replace(
	// 		replacement.match[0],
	// 		`@${replacement.username}`
	// 	);
	// }

	// /g is important.
	cleanText = cleanText
		.replace(/&gt;/g, '>')
		.replace(/&lt;/g, '<')
		.replace(/&amp;/g, '&');

	if (prText) {
		prText = prText
			.replace(/&gt;/g, '>')
			.replace(/&lt;/g, '<')
			.replace(/&amp;/g, '&');
	}

	const prInfo = cleanText.match(/_.*·.*Waiting.*_.*_/)?.[0];

	// Now get all the component parts
	let description = cleanText.split('*')[1];
	return {
		embed: {
			title: prText,
			description: `**${description}** - ${manageReminderUrl}${
				prInfo ? '\n\n' + prInfo : ''
			}`,
			url: prLink,
			color: 0x17a2b8,
		},
	};
}

async function fetchGithubProfile(pullRequestUrl: string) {
	// Get the user's associated with this PR
	// Now, try to map their names to something on Discord
	return ['Kevin'];
}

async function fetchDiscordChannelUsers() {
	// Get the guild & channel from the config
	discordBot.guilds.get('')?.members;
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
	const data = await slackWeb.users.profile.get({ user: user });
	let cached_profile = {
		username:
			data.profile?.display_name_normalized ||
			data.profile?.real_name_normalized,
		avatar_url: data.profile?.image_192,
	};
	log(`Profile received for ${cached_profile.username}`, 'slack', 3);
	slack_profiles_cache[user] = cached_profile;
}

async function forwardGitHubScheduleReminderToDiscord(
	slackMessage: AppMentionEvent
) {
	log(JSON.stringify(slackMessage, null, 3), 'slack', 3);
	try {
		const options = await constructDiscordEmbedPayload(slackMessage);
		discordBot.executeWebhook(
			process.env.DISCORD_HOOK_ID || '',
			process.env.DISCORD_HOOK_TOKEN || '',
			options
		);
		// console.log(JSON.stringify(options));
	} catch (err) {
		log(`Error while forwarding to Discord: ${err}`, 'slack', 0);
	}
}

// Receive messages that have the following text in them
app.message('Pending review on banda-health', async ({ message }) => {
	// Just forward the message to discord
	forwardGitHubScheduleReminderToDiscord(message as unknown as AppMentionEvent);
});

(async () => {
	discordBot.on('ready', () => {
		console.log('Listening for discord events.');
	});
	await Promise.all([app.start(), discordBot.connect()]);
	console.log('⚡️ Bolt app is running!');
})();
