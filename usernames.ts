import { readFileSync } from 'fs';
import { writeFile } from 'fs/promises';
import { join } from 'path';

const associationsFileName = join(__dirname, 'associations.json');

let usernameAssociationsCache: { [gitHubOrSlackUsername: string]: string } = {};
let areUserNameAssociationsLoaded = false;

/**
 * Get the Discord username to use instead of a GitHub or Slack username
 * @param gitHubOrSlackUsername THe username that came from either Slack (because the GitHub bot changed it) or
 * from GitHub (because the Github bot couldn't find an association in Slack)
 * @returns A Discord username, if one is found
 */
export function getDiscordUserNameFromGitHubOrSlackUsername(
	gitHubOrSlackUsername: string
) {
	if (!areUserNameAssociationsLoaded) {
		try {
			usernameAssociationsCache = JSON.parse(
				readFileSync(associationsFileName).toString()
			);
			areUserNameAssociationsLoaded = true;
		} catch (err) {
			console.log('Error loading associations...', err);
		}
	}

	return usernameAssociationsCache[gitHubOrSlackUsername];
}

/**
 * Associate a GitHub or Slack username with a Discord username
 * @param gitHubOrSlackUserName The GitHub or Slack username that will be associated with a Discord username
 * @param discordUserName The Discord username to be used when the GitHub or Slack username is seen
 */
export function associate(
	gitHubOrSlackUserName: string,
	discordUserName: string
) {
	usernameAssociationsCache[gitHubOrSlackUserName] = discordUserName;
	saveAssociations();
}

/**
 * Remove the GitHub or Slack username from any previously associations
 * @param gitHubOrSlackUserName The GitHub or Slack username to remove from any associations
 */
export function dissociate(gitHubOrSlackUserName: string) {
	delete usernameAssociationsCache[gitHubOrSlackUserName];
	saveAssociations();
}

function saveAssociations() {
	writeFile(
		associationsFileName,
		JSON.stringify(usernameAssociationsCache, null, 2)
	).catch((err) => {
		console.log('There was an error saving the associations: ', err);
	});
}
