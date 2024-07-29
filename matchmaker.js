import Player from './player.js'
import GameRoom from './gameroom.js';
import RoomManager from './roommanager.js'
import { WebSocketServer } from 'ws'
import { v4 as uuidv4 } from 'uuid';

import { upload_to_blob_storage } from './blobstorage.js';
import validate_message from './messagevalidator.js';

class Matchmaker {
    constructor(room_manager) {
        this.room_manager = room_manager
        this.match_queues = {}

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
                "waiting_version" : Number
            }
        }
    }

    remove_from_matchmaking(player) {
        for (queue in this.match_queues.values) {
            if (queue["waiting_player"] == player) {
                this.match_queues[queue]["waiting_player"] = null
            }
        }
    }

    join_matchmaking(ws, json_data) {
        if (!(validate_message(json_data, "join_matchmaking"))) {
            return false
        }

        var joining_player = active_connections.get(ws)
        if (joining_player === undefined) {
            console.log("join_matchmaking Player is undefined")
            return false
        }

        var player_join_version = json_data.version
        var deck_id = json_data.deck_id
        joining_player.set_deck_id(deck_id)
        var desired_queue_type = json_data.queue_type
        
        if (this.matchmaking_queue_types[desired_queue_type]["banned_characters"].includes(deck_id)) {
            const message = {
                type: 'matchmaking_failed',
                reason: 'banned_matchmaking_character'
            }
            ws.send(JSON.stringify(message))
            return true
        }

        var success = false

        if (this.match_queues[desired_queue_type]["waiting_player"] === null) {
            match_queues[desired_queue_type]["waiting_player"] = joining_player
            match_queues[desired_queue_type]["waiting_json_data"] = json_data
            match_queues[desired_queue_type]["waiting_version"] = player_join_version
            success = true
        } else {
            waiting_player = match_queues[waiting_player]
            waiting_json_data = match_queues[waiting_json_data]
            waiting_version = waiting_json_data.version

            if (waiting_version < player_join_version) {
                // The player joining has a later version.
                // Kick the waiting player from matchmaking,
                // then put the joining player in their place.
                send_join_version_error(waiting_player.ws)
                this.remove_from_matchmaking(waiting_player)
                match_queues[desired_queue_type]["waiting_player"] = joining_player
                match_queues[desired_queue_type]["waiting_json_data"] = json_data
                match_queues[desired_queue_type]["waiting_version"] = player_join_version
                success = true
            } else if (waiting_version > player_join_version) {
                // Earlier version than the waiting player. 
                // Probably needs to update. Send an error message.
                send_join_version_error(ws)
                return true
            } else {
                // Make a room and join it successfully.
                const room = this.room_manager.create_room(waiting_player, 
                    waiting_json_data, 
                    starting_timer, 
                    enforce_timer, 
                    minimum_time_per_choice)
                success = room.join(player)
                if (!success) {
                    const message = {
                        type: 'matchmaking_failed',
                        reason: 'room_join_failed'
                    }
                    ws.send(JSON.stringify(message))
                    return true
                }
                this.match_queues[desired_queue_type]["waiting_player"] === null
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
}

export default Matchmaker