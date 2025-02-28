
const MatchmakingStartingTimer = 15 * 60
const MatchmakingEnforceTimer = false
const MatchmakingMinimumTimePerChoice = 20
const MatchmakingBestOf = 1

// TODO: Read this from blob storage
const queue_config = [
    {
        id: "season3to7",
        name: "Season 3-7 Only",
        season_restriction: { "min": 3, "max": 7 },
        custom_allowed: false,
        banned: [
            "carmine"
        ],
        starting_timer: MatchmakingStartingTimer,
        enforce_timer: MatchmakingEnforceTimer,
        minimum_time_per_choice: MatchmakingMinimumTimePerChoice,
        best_of: MatchmakingBestOf,
    },
    {
        id: "allseasons",
        name: "All Seasons",
        season_restriction: { "min": 1, "max": 7 },
        custom_allowed: false,
        banned: [
            "carmine"
        ],
        starting_timer: MatchmakingStartingTimer,
        enforce_timer: MatchmakingEnforceTimer,
        minimum_time_per_choice: MatchmakingMinimumTimePerChoice,
        best_of: MatchmakingBestOf,
    },
    {
        id: "anything",
        name: "Anything Goes",
        season_restriction: { "min": 1, "max": 7 },
        custom_allowed: true,
        banned: [],
        starting_timer: MatchmakingStartingTimer,
        enforce_timer: MatchmakingEnforceTimer,
        minimum_time_per_choice: MatchmakingMinimumTimePerChoice,
        best_of: MatchmakingBestOf,
    }
]

const decks = [
    { "character": "akuma", "season": 3 },
    { "character": "anji", "season": 7 },
    { "character": "arakune", "season": 5 },
    { "character": "axl", "season": 7 },
    { "character": "baiken", "season": 7 },
    { "character": "bang", "season": 5 },
    { "character": "beheaded", "season": 4 },
    { "character": "bison", "season": 3 },
    { "character": "byakuya", "season": 6 },
    { "character": "cammy", "season": 3 },
    { "character": "carlclover", "season": 5 },
    { "character": "carlswangee", "season": 2 },
    { "character": "carmine", "season": 6 },
    { "character": "celinka", "season": 2 },
    { "character": "chaos", "season": 6 },
    { "character": "chipp", "season": 7 },
    { "character": "chunli", "season": 3 },
    { "character": "cviper", "season": 3 },
    { "character": "dan", "season": 3 },
    { "character": "emogine", "season": 2 },
    { "character": "enchantress", "season": 4 },
    { "character": "enkidu", "season": 6 },
    { "character": "faust", "season": 7 },
    { "character": "fight", "season": 4 },
    { "character": "galdred", "season": 2 },
    { "character": "giovanna", "season": 7 },
    { "character": "goldlewis", "season": 7 },
    { "character": "gordeau", "season": 6 },
    { "character": "guile", "season": 3 },
    { "character": "hakumen", "season": 5 },
    { "character": "happychaos", "season": 7 },
    { "character": "hazama", "season": 5 },
    { "character": "hilda", "season": 6 },
    { "character": "hyde", "season": 6 },
    { "character": "iaquis", "season": 2 },
    { "character": "ino", "season": 7 },
    { "character": "jacko", "season": 7 },
    { "character": "jin", "season": 5 },
    { "character": "ken", "season": 3 },
    { "character": "king", "season": 4 },
    { "character": "kokonoe", "season": 5 },
    { "character": "kykisuke", "season": 7 },
    { "character": "leo", "season": 7 },
    { "character": "linne", "season": 6 },
    { "character": "litchi", "season": 5 },
    { "character": "londrekia", "season": 6 },
    { "character": "may", "season": 7 },
    { "character": "merkava", "season": 6 },
    { "character": "mika", "season": 6 },
    { "character": "millia", "season": 7 },
    { "character": "mole", "season": 4 },
    { "character": "nago", "season": 7 },
    { "character": "nanase", "season": 6 },
    { "character": "nine", "season": 5 },
    { "character": "noel", "season": 5 },
    { "character": "nu13", "season": 5 },
    { "character": "orie", "season": 6 },
    { "character": "phonon", "season": 6 },
    { "character": "plague", "season": 4 },
    { "character": "platinum", "season": 5 },
    { "character": "polar", "season": 4 },
    { "character": "potemkin", "season": 7 },
    { "character": "propeller", "season": 4 },
    { "character": "rachel", "season": 5 },
    { "character": "ragna", "season": 5 },
    { "character": "ramlethal", "season": 7 },
    { "character": "ryu", "season": 3 },
    { "character": "sagat", "season": 3 },
    { "character": "seijun", "season": 2 },
    { "character": "seth", "season": 6 },
    { "character": "shovelshield", "season": 4 },
    { "character": "solbadguy", "season": 7 },
    { "character": "specter", "season": 4 },
    { "character": "sydney", "season": 2 },
    { "character": "tager", "season": 5 },
    { "character": "taokaka", "season": 5 },
    { "character": "testament", "season": 7 },
    { "character": "tinker", "season": 4 },
    { "character": "treasure", "season": 4 },
    { "character": "vatista", "season": 6 },
    { "character": "vega", "season": 3 },
    { "character": "wagner", "season": 6 },
    { "character": "waldstein", "season": 6 },
    { "character": "yuzu", "season": 6 },
    { "character": "zangief", "season": 3 },
    { "character": "zato", "season": 7 }
]


export default class QueueManager {
    constructor(database, discord_connection, room_manager) {
        this.database = database
        this.discord_connection = discord_connection
        this.room_manager = room_manager
        this.queues = []
        this.config = queue_config
        this.running_match_id = 1

        for (const config of this.config) {
            var queue = {
                id: config.id,
                name: config.name,
                season_restriction: config.season_restriction,
                custom_allowed: config.custom_allowed,
                banned: config.banned,
                starting_timer: config.starting_timer,
                enforce_timer: config.enforce_timer,
                minimum_time_per_choice: config.minimum_time_per_choice,
                best_of: config.best_of,

                waiting_room: null,
            }
            this.queues.push(queue)
        }
    }

    validateDeck(queue_id, deck_id) {
        const queue = this.getQueueById(queue_id)
        if (!queue) {
            return false
        }
        const deck = decks.find(deck => deck.character === deck_id)
        if (!deck) {
            return false
        }

        if (queue.custom_allowed) {
            return true
        }

        if (deck.season < queue.season_restriction.min || deck.season > queue.season_restriction.max) {
            return false
        }

        if (queue.banned.includes(deck_id)) {
            return false
        }

        return true
    }

    getQueueInfos() {
        // Each queue has id, name, and match_available fields.
        return this.queues.map(queue => {
            return {
                id: queue.id,
                name: queue.name,
                match_available: queue.waiting_room !== null
            }
        })
    }

    addPlayer(queue_id, player, player_join_version) {
        const queue = this.getQueueById(queue_id)
        if (!queue) {
            console.log(`Couldn't find queue ${queue_id}`)
            return false
        }

        var success = false
        if (queue.waiting_room) {
            // A room already exists for this match.
            if (queue.waiting_room.version < player_join_version) {
                // The player joining has a larger version,
                // kick the player in the room and make a new one.
                var player_in_room = queue.waiting_room.players[0]
                send_join_version_error(player_in_room.ws)
                this.room_manager.leaveRoom(player_in_room, false)
                queue.waiting_room = this.createNewMatchRoom(queue, player_join_version, player)
                success = true
            } else if (queue.waiting_room.version > player_join_version) {
                // Lower version than room, probably need to update.
                // Send error message.
                send_join_version_error(ws)
                return true
            } else {
                // Join the room successfully.
                success = queue.waiting_room.join(player)
                // QueueManager is no longer managing this room.
                queue.waiting_room = null
            }
        } else {
            // No room exists, create a new one for this match.
            queue.waiting_room = this.createNewMatchRoom(queue, player_join_version, player)
            success = true
        }
        return success
    }

    findQueueWithRoom(room_name) {
        for (const queue of this.queues) {
            if (queue.waiting_room) {
                if (queue.waiting_room.name === room_name) {
                    return queue
                }
            }
        }
        return null
    }

    leaveRoom(player) {
        // Find if this player was queued in any of the queue waiting rooms.
        // If so, remove that waiting room.
        for (const queue of this.queues) {
            if (queue.waiting_room) {
                if (queue.waiting_room.is_player(player)) {
                    queue.waiting_room = null
                }
            }
        }
    }

    createNewMatchRoom(queue, version, player) {
        const room_name = "Match_" + this.getNextMatchId()
        const new_room = this.room_manager.addRoom(
            version,
            room_name,
            this.database,
            queue.starting_timer,
            queue.enforce_timer,
            queue.minimum_time_per_choice
        )
        new_room.join(player)
        this.discord_connection.sendMatchmakingNotification(player.name, queue.name)
        return new_room
    }

    getQueueById(id) {
        return this.queues.find(queue => queue.id === id)
    }

    getNextMatchId() {
        var value = this.running_match_id++
        if (this.running_match_id > 999) {
            this.running_match_id = 1
        }
        return value
    }
}

function send_join_version_error(ws) {
    const message = {
        type: 'room_join_failed',
        reason: 'version_mismatch'
    }
    ws.send(JSON.stringify(message))
}
