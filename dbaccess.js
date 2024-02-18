import sql from 'mssql'
import retry from 'async-retry';
import { performance } from 'perf_hooks';

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
            console.log(`DATABASE: Connecting...${this.connected}`);
            if (this.connected === false) {
                this.poolconnection = await sql.connect(this.config);
                this.poolconnection.on( "error", async err => {
                    console.log('DATABASE: Connection error, closing pool');
                    await disconnect();
                } );
                this.connected = true;
                console.log('DATABASE: Connection successful');
            } else {
                console.log('DATABASE: Already connected');
            }
        } catch (error) {
            // If error is string, just print it
            console.error(`DATABASE: Error connecting to database: ${error}`);
        }
    }

    async disconnect() {
        try {
            await this.poolconnection.close();
            this.connected = false;
            console.log('DATABASE: Connection closed');
        } catch (error) {
            this.connected = false;
            console.error(`DATABASE: Error closing database connection: ${error}`);
        }
    }

    async executeQuery(query, params) {
        const startTime = performance.now();
        console.log(`DATABASE: Executing query`)
        const outer_result = await retry(async () => {
            await this.connect();
            const request = this.poolconnection.request();
            if (params) {
                for (const [key, value] of Object.entries(params)) {
                    request.input(key, value);
                }
            }
            const result = await request.query(query);
            var elapsedMs = performance.now() - startTime;
            console.log(`DATABASE: result after ${elapsedMs}ms: ${JSON.stringify(result)}`);
            return result.rowsAffected.length ? result.rowsAffected[0] : 0
        }, {
            retries: 3,
            minTimeout: 5000,
            maxTimeout: 25000,
            factor: 2,
            randomize: true,
            onRetry: (err, attempt) => {
                var elapsedMs = performance.now() - startTime;
                console.log(`DATABASE: Retrying (${elapsedMs}ms) (${attempt}/${3}): ${err}`);
            }
        });

        return outer_result;
    }

    // Function to insert a new entry into the MatchData table
    async insertMatchData(matchData) {
        this.executeQuery(`
            INSERT INTO MatchData (MatchId, Player1Name, Player2Name, Player1Character, Player2Character, StartTime, EndTime, MatchResult, GameVersion, MatchLog, MatchEventLength, FirstPlayer, Player1Life, Player2Life, Disconnects)
            VALUES (
                @MatchId,
                @Player1Name,
                @Player2Name,
                @Player1Character,
                @Player2Character,
                @StartTime,
                @EndTime,
                @MatchResult,
                @GameVersion,
                @MatchLog,
                @MatchEventLength,
                @FirstPlayer,
                @Player1Life,
                @Player2Life,
                @Disconnects
            )
        `, {
            MatchId: matchData.MatchId,
            Player1Name: matchData.Player1Name,
            Player2Name: matchData.Player2Name,
            Player1Character: matchData.Player1Character,
            Player2Character: matchData.Player2Character,
            StartTime: formatDate(matchData.StartTime),
            EndTime: formatDate(matchData.EndTime),
            MatchResult: matchData.MatchResult,
            GameVersion: matchData.GameVersion,
            MatchLog: matchData.MatchLog,
            MatchEventLength: matchData.MatchEventLength,
            FirstPlayer: matchData.FirstPlayer,
            Player1Life: matchData.Player1Life,
            Player2Life: matchData.Player2Life,
            Disconnects: matchData.Disconnects
        }).then(() => {
            console.log('DATABASE: Match inserted successfully');
        })
        .catch(err => {
            console.error('DATABASE: Error inserting entry:', err);
        });
    }
}

