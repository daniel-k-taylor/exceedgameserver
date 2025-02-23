import  { Client, GatewayIntentBits } from "discord.js";

export default class DiscordConnection {

    client = null;

    constructor() {
        // If the DISCORD_TOKEN env variable is set, create the client.
        if (process.env.DISCORD_TOKEN)
        {
            this.client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
            this.client.once('ready', () => {
                console.log(`Discord: Logged in as ${this.client.user.tag}!`);
                const channels = this.client.channels.cache.map(channel => `${channel.name} (${channel.id})`);
                console.log('Available channels:', channels);
            });
            this.client.login(process.env.DISCORD_TOKEN);
        }
    }

    sendMatchmakingNotification(playerName) {
        console.log(`Sending matchmaking notification to Discord: ${process.env.DISCORD_CHANNEL_ID}`);
        const channel = this.client.channels.cache.get(process.env.DISCORD_CHANNEL_ID);
        if (channel) {
            const timestamp = Math.floor(Date.now() / 1000); // Current time in seconds (UNIX timestamp)
            const gameUrl = process.env.GAME_URL;
            channel.send(`<t:${timestamp}:t> Player is looking for a match! [Play now!](<${gameUrl}>)`);
        }
    }
};