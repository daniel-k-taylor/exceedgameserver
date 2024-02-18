import sql from 'mssql'

function formatDate(date) {
    const isoString = date.toISOString();
    // Extract date and time parts separately and concatenate them
    return isoString.split('T')[0] + ' ' + isoString.split('T')[1].split('.')[0];
  }

export default class Database {

    // Configure database connection using environment variables
    config = {};
    poolconnection = null;
    connected = false;

    constructor(config=null) {
        this.config = config;
        console.log(`Database: config: ${JSON.stringify(config)}`);
    }

    async connect() {
        try {
            console.log(`Database connecting...${this.connected}`);
            if (this.connected === false) {
                this.poolconnection = await sql.connect(this.config);
                this.connected = true;
                console.log('Database connection successful');
            } else {
                console.log('Database already connected');
            }
        } catch (error) {
            // If error is string, just print it
            console.error(`Error connecting to database: ${error}`);
        }
    }

    async disconnect() {
        try {
            this.poolconnection.close();
            console.log('Database connection closed');
        } catch (error) {
            console.error(`Error closing database connection: ${error}`);
        }
    }

    async executeQuery(query) {
        await this.connect();
        const request = this.poolconnection.request();
        const result = await request.query(query);

        return result.rowsAffected[0];
    }

    // Function to insert a new entry into the MatchData table
    async insertMatchData(matchData) {
        await this.connect();
        if (!this.connected) {
            console.error('DATABASE: Aborting since no connection');
            return
        }

        this.executeQuery(`
            INSERT INTO MatchData (MatchId, Player1Name, Player2Name, Player1Character, Player2Character, StartTime, EndTime, MatchResult, GameVersion, MatchLog, MatchEventLength, FirstPlayer, Player1Life, Player2Life, Disconnects)
            VALUES (
                '${matchData.MatchId}',
                '${matchData.Player1Name}',
                '${matchData.Player2Name}',
                '${matchData.Player1Character}',
                '${matchData.Player2Character}',
                '${formatDate(matchData.StartTime)}',
                '${formatDate(matchData.EndTime)}',
                '${matchData.MatchResult}',
                '${matchData.GameVersion}',
                '${matchData.MatchLog}',
                '${matchData.MatchEventLength}',
                '${matchData.FirstPlayer}',
                '${matchData.Player1Life}',
                '${matchData.Player2Life}',
                '${matchData.Disconnects}'
            )
        `).then(() => {
            console.log('DATABASE: Match inserted successfully');
        })
        .catch(err => {
            console.error('DATABASE: Error inserting entry:', err);
        });
    }
}

