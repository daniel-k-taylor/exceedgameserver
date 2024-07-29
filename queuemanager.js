// Handles both matchmaking queues and queues for custom games (a custom game queue
// fulfill the role of a lobby for a custom game).

import Player from './player.js'
import GameRoom from './gameroom.js';
import RoomManager from './roommanager.js'
import { WebSocketServer } from 'ws'
import { v4 as uuidv4 } from 'uuid';

import { upload_to_blob_storage } from './blobstorage.js';
import validate_message from './messagevalidator.js';

class QueueManager {
    constructor(room_manager) {
        this.room_manager = room_manager

        // Queues are stored in the dict this.match_queues. The keys for custom
        // queues are positive integers, while the keys for matchmaking queues are
        // strings. In the code these keys are referred to as "queue_id"s.

        // Each queue is a dict with the following fields: 
        // - banned_characters : an array of strings. These are deck ids for the queue to reject.
        // Only checked if the queue is a matchmaking queue.
        // - queue_display_name : string. what we show the user. only checked if
        // the queue is a custom queue.
        // - waiting_player : player. for matchmaking queues, this should be null if
        // nobody is waiting. for custom queues, we should delete the queue right away if
        // the player is no longer in it.
        // - waiting_json_data : json
        // - waiting_version : string
        // - is_custom : bool. this could currently be inferred from the key type.

        this.match_queues = {}

        this.running_queue_id = 1

        this.matchmaking_queue_types = {
            "untimed" : {
                "starting_timer" : 0,
                "enforce_timer" : false,
                "minimum_time_per_choice" : 0,
                "banned_characters" : ["carmine"]
            },
            "timed" : {
                "starting_timer" : 12,
                "enforce_timer" : true,
                "minimum_time_per_choice" : 20,
                "banned_characters" : ["carmine"]
            },
            "speed" : {
                "starting_timer" : 6,
                "enforce_timer" : true,
                "minimum_time_per_choice" : 10,
                "banned_characters" : ["carmine"]
            }
        }

    for (queue_type in this.matchmaking_queue_types.keys) {
            this.match_queues[queue_type] = {
                "waiting_player" : player = null,
                "waiting_json_data" : object = null,
                "waiting_version" : Number,
                "is_custom" : false,
                "banned_characters" : this.matchmaking_queue_types["banned_characters"]
            }
        }
    }

    _get_next_queue_id() {
        // Assumption that queues will always expire too quickly for the
        // wraparound to be relevant
        var value = this.running_queue_id++
        if (this.running_queue_id > 999) {
            this.running_queue_id = 1
        }
        return value
    }

    remove_from_queue(player, queue_id=null) {
        // Calling this without a second argument removes the player from all queues.
        if (queue_to_remove_from === null) {
            for (to_remove in this.match_queues.keys()) {
                this.remove_from_queue(player, to_remove)
            }
        } else {
            // Check if the user is in the specified queue, and remove them from it if so.
            queue = this.match_queues[queue_id]
            if (queue["waiting_player"] == player) {
                if (queue["is_custom"]) {
                    delete match_queues[queue_id]
                } else {
                    queue["waiting_player"] = null
                }
            }
        }
    }


    join_queue(ws, json_data) {
        // Required json parameters:
        // - deck_id : string
        // - version : string
        // - starting_timer : int
        // - minimum_time_per_choice : int
        // - enforce_timer : bool
        // - queue_type : string. For a matchmaking queue, this should be a matchmaking queue type.
        // Otherwise, this should be "custom"
        // - desired_queue_id : int. Only used when queue_type == "custom".
        // If the player is attempting to start a new queue, this should be 0.
        // If the player is attempting to join an existing custom queue, this should be the
        // id of that queue. 
        // - queue_display_name : string. Only used when queue_type == "custom".

        // To simplify interface logic, the desired behaviour is to be able to join any number of 
        // matchmaking queues at a time, but to outlaw being in a custom queue plus another queue 
        // of any type at the same time.
        
        if (!(validate_message(json_data, "join_queue"))) {
            return false
        }

        var joining_player = active_connections.get(ws)
        if (joining_player === undefined) {
            console.log("join_queue player is undefined")
            return false
        }

        var desired_queue_type = json_data.queue_type
        var desired_queue_id = json_data.desired_queue_id

        var player_join_version = json_data.version

        var success = false

        if (desired_queue_type == "custom") {
            // Joining a custom queue logic

            this.remove_from_queue(joining_player)

            if (desired_queue_id == 0) {
                // Player is starting a new custom queue.
                this.match_queues[this._get_next_queue_id()] = {
                    banned_characters : [],
                    queue_display_name : json_data.queue_display_name,
                    waiting_player : joining_player,
                    waiting_json_data : json_data,
                    waiting_version : version,
                    is_custom : true
                }
            } else {
                if (desired_queue_id in this.match_queues.keys()) {
                    queue = this.match_queues[desired_queue_id]
                    waiting_player = queue["waiting_player"]
                    waiting_json_data = queue["waiting_json_data"]
                    waiting_version = queue["waiting_version"]
        
                    if (waiting_version < player_join_version) {
                        // The player joining has a later version.
                        // Send the waiting player an error message.
                        // They probably need to update.
                        this._join_version_error(waiting_player.ws)
                        return true
                    } else if (waiting_version > player_join_version) {
                        // The player joining has an earlier version. 
                        // Probably needs to update. Send an error message.
                        this._join_version_error(ws)
                        return true
                    } else {
                        // Make a room and join it successfully.

                        // Putting this before the success check means we will kick both players
                        // from queues even if the room creation fails. lmk if this is undesirable
                        this.remove_from_queue(joining_player)
                        this.remove_from_queue(waiting_player)

                        joining_player.set_deck_id(json_data.deck_id)
                        waiting_player.set_deck_id(waiting_json_data.deck_id)

                        success = this.room_manager.create_room(joining_player,
                            waiting_player,
                            player_join_version,
                            queue_type,
                            waiting_json_data.starting_timer, 
                            waiting_json_data.enforce_timer, 
                            waiting_json_data.minimum_time_per_choice)
                        if (!success) {
                            const message = {
                                type: 'custom_room_join_failed', // not sure what this should be
                                reason: 'room_join_failed'
                            }
                            ws.send(JSON.stringify(message))
                            return true
                        }
                    }
                } else {
                    // Player wanted to join an existing queue, but the queue doesn't exist
                    const message = {
                        type: 'custom_queue_join_failed', // again, not sure what this should be
                        reason: 'custom_queue_does_not_exist'
                    }
                    ws.send(JSON.stringify(message))
                    return true
                }
            }
        } else {
            // Joining a matchmaking queue logic

            queue = this.match_queues[desired_queue_type]
            queue_type = this.matchmaking_queue_types[desired_queue_type]

            // Remove from all custom queues (but not matchmaking queues)
            for (queue_id in this.match_queues.keys()) {
                if (this.match_queues[queue_id]["is_custom"]) {
                    this.remove_from_queue(joining_player, queue_id)
                }
            }

            if (queue["banned_characters"].includes(deck_id)) {
                const message = {
                    type: 'matchmaking_failed',
                    reason: 'banned_matchmaking_character'
                }
                ws.send(JSON.stringify(message))
                return true
            }

            if (queue["waiting_player"] === null) {
                queue["waiting_player"] = joining_player
                queue["waiting_json_data"] = json_data
                queue["waiting_version"] = player_join_version
                return true
            } else {
                // Queue is already occupied, so we have a match
                waiting_player = queue["waiting_player"]
                waiting_json_data = queue["waiting_json_data"]
                waiting_version = queue["waiting_version"]
    
                if (waiting_version < player_join_version) {
                    // The player joining has a later version.
                    // Kick the waiting player from all queues,
                    // then put the joining player in their place in the current queue.
                    
                    this._join_version_error(waiting_player.ws)

                    this.remove_from_queue(waiting_player)
                    queue["waiting_player"] = joining_player
                    queue["waiting_json_data"] = json_data
                    queue["waiting_version"] = player_join_version

                    success = true

                } else if (waiting_version > player_join_version) {
                    // Earlier version than the waiting player. 
                    // Probably needs to update. Send an error message.
                    this._join_version_error(ws)
                    return true
                } else {
                    // Make a room and join it successfully.

                    // Putting this before the success check means we will kick both players
                    // from queues even if the room creation fails. lmk if this is undesirable
                    this.remove_from_queue(joining_player)
                    this.remove_from_queue(waiting_player)

                    joining_player.set_deck_id(json_data.deck_id)
                    waiting_player.set_deck_id(waiting_json_data.deck_id)

                    success = this.room_manager.create_room(
                        joining_player,
                        waiting_player,
                        player_join_version,
                        queue_type,
                        queue_type["starting_timer"], 
                        queue_type["enforce_timer"],
                        queue_type["minimum_time_per_choice"]
                    )
                    if (!success) {
                        const message = {
                            type: 'matchmaking_room_join_failed', // not sure what this should be
                            reason: 'room_join_failed'
                        }
                        ws.send(JSON.stringify(message))
                        return true
                    }
                }
            }
        }

        if (!success) {
                const message = {
                    type: 'matchmaking_failed',
                    reason: 'queue_join_failed'
                }
            ws.send(JSON.stringify(message))
        }

        return true
    }

    _join_version_error(ws) {
        const message = {
            type: 'room_join_failed',
            reason: 'version_mismatch'
        }
        ws.send(JSON.stringify(message))
    }
}

export default Matchmaker