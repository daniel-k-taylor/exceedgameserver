export default class QueueManager {
    constructor(database, server_config, discord_connection, room_manager) {
        this.database = database
        this.discord_connection = discord_connection
        this.room_manager = room_manager
        this.running_match_id = 1
        this.queue_config = server_config["queue_config"]
        this.decks = server_config["decks"]

        this.initQueues()
    }

    initQueues() {
        this.queues = []
        for (const config of this.queue_config) {
            var queue = {
                id: config["id"],
                name: config["name"],
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

    updateServerConfig(server_config) {
        this.decks = server_config["decks"]

        // Check if the queue config has changed by looking
        // at the queue ids. If the ids are the same, do nothing.
        const old_ids = this.queue_config.map(config => config.id)
        const new_ids = server_config["queue_config"].map(config => config.id)
        if (JSON.stringify(old_ids) === JSON.stringify(new_ids)) {
            return
        }

        // Queues are different, delete the old queues.
        for (const queue of this.queues) {
            if (queue.waiting_room) {
                this.room_manager.deleteRoom(queue.waiting_room.name)
            }
        }

        // Create new queues.
        this.queue_config = server_config["queue_config"]
        this.initQueues()
    }

    validateDeck(queue_id, deck_id) {
        // If the player picks random, their deck_id is random_*#deck_id
        // Where * is either s1, s2, etc. or just plain random#deck_id if all season random.
        // Just remove the # and everything before it if it is there.
        if (deck_id.startsWith("random")) {
            deck_id = deck_id.split("#")[1]
        }
        const queue = this.getQueueById(queue_id)
        if (!queue) {
            console.log(`Couldn't find queue ${queue_id}`)
            return false
        }

        if (queue.custom_allowed && deck_id.startsWith("custom")) {
            return true
        }

        const deck = this.decks.find(deck => deck.character === deck_id)
        if (!deck) {
            console.log(`Couldn't find deck ${deck_id}`)
            return false
        }

        if (deck.season < queue.season_restriction.min || deck.season > queue.season_restriction.max) {
            return false
        }

        if (queue.banned.includes(deck_id)) {
            return false
        }

        return true
    }

    validateCustomDeck(deck_definition) {
        if (!deck_definition) {
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
