# Forward GitHub App Message from Slack
This app is meant to take the messages that GitHub publishes to Slack via it's Scheduled Reminder app and post them to Discord.

### Inspiration
It is based on and inspired by the following two repositories:

https://github.com/HackSoc/slack-discord-bridge
https://github.com/NickMandylas/slack-discord-bridge

## Setup
### Slack & Discord Bots
Use the instructions in the above-mentioned repositories to set everything up for yourself. The only things you don't need are the permissions that allow this Slack App to post to a channel (since it just reads and forwards to Discord).

### Running
Set up by cloning locally, then set up your `.env` file (you can use the `.env.default` file as guide). To start, run
```
docker compose up
```

## Updating Discord Associations
The GitHub application tries to associate users who made the PRs with users in Slack. However, neither of these is in Discord. Rather than trying to do any complex mapping, this Bot allows you to define your own associations between Slack/GitHub usernames and Discord User IDs.

You can [enable developer mode in Discord](https://discord.com/developers/docs/game-sdk/store#application-test-mode) and then right-click on any user to get an ID for using in mentions.

Once this is done, you can use the following commands in your Slack Workspace:
```
associate [slackOrGitHubUsername] [discordUserID]
```
As long as the Slack or GitHub username is unique, they can share Discord User IDs. To remove an association, call the following:
```
dissociate [slackOrGitHubUsername]
```