import  { ChannelType, Client, GatewayIntentBits } from "discord.js";

export default class DiscordConnection {

    client = null;

    constructor() {
        // If the DISCORD_TOKEN env variable is set, create the client.
        if (process.env.DISCORD_TOKEN)
        {
            this.client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
            this.client.once('ready', () => {
                console.log(`Discord: Logged in as ${this.client.user.tag}!`);
                // const channels = this.client.channels.cache.map(channel => `${channel.name} (${channel.id})`);
                // console.log('Available channels:', channels);
            });
            this.client.login(process.env.DISCORD_TOKEN);
        }
    }

    sendMatchmakingNotification(playerName) {
        // Get all the guilds (servers) the bot is in
        const desired_channel = process.env.DISCORD_CHANNEL_NAME
        const gameUrl = process.env.GAME_URL;
        const timestamp = Math.floor(Date.now() / 1000); // Get current timestamp
        const message = `<t:${timestamp}:t> Player is looking for a match! [Play now!](<${gameUrl}>)`
        if (desired_channel)
        {
            this.client.guilds.cache.forEach(async (guild) => {
                // Find a channel by name or other identifiers (e.g., #matchmaking)
                const channel = guild.channels.cache.find(
                    (ch) => ch.name === desired_channel && ch.type === ChannelType.GuildText // Ensure it’s a text channel
                );

                if (channel) {
                    channel.send(message);
                } else {
                    console.error(`No '${desired_channel}' channel found in ${guild.name}`);
                }
            });
        }
        const specific_channel_id = process.env.DISCORD_CHANNEL_ID
        if (specific_channel_id)
        {
            console.log(`Sending matchmaking notification to Discord: ${process.env.DISCORD_CHANNEL_ID}`);
            const channel = this.client.channels.cache.get(process.env.DISCORD_CHANNEL_ID);
            if (channel) {
                channel.send(message);
            }
        }
    }
};