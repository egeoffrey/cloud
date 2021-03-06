class Mqtt_client {
    constructor(module) {
        // we need the module's object to call its methods
        this.__module = module
        // mqtt object
        this.__gateway = null;
        // track the topics subscribed
        this.__topics_to_subscribe = []
        this.__topics_subscribed = []
        this.__topics_to_wait = []
        // queue messages while offline
        this.__publish_queue = []
        // queue configuration messages while not configured
        this.__configuration_queue = []
        // if the configuration is not retained in the gateway, we need additional tools for requesting it
        if (this.__module.gateway_version >= 2) {
            this.pending_configurations = []
            this.pending_configurations_job = null
        }
    }

    // notify controller/config we need some configuration files
    __send_configuration_request(topic) {
        var message = new Message(this.__module)
        message.recipient = "controller/config"
        message.command = "SUBSCRIBE"
        message.set_data(topic)
        this.__module.send(message)
    }

    // job for periodically sending configuration request if controller/config does not respond or it is not running
    __resend_configuration_request() {
        // if we received all the pending configurations, clear the scheduled job
        if (this.pending_configurations.length == 0) {
            clearInterval(this.pending_configurations_job)
            this.pending_configurations_job = null
            return
        } else {
            // otherwise for each pending configuration, send again a request to controller/config
            for (var topic of this.pending_configurations) {
                this.__send_configuration_request(topic)
            }
        }
    }

    // connect to the MQTT broker
    __connect() {
        var this_class = this
        var __on_connect = function(reconnect, url) {
            this_class.__module.log_info("Connected to eGeoffrey gateway "+this_class.__module.gateway_hostname+":"+this_class.__module.gateway_port)
            this_class.__module.connected = true
            this_class.__module.on_connect()
            // subscribe to the requested topics
            for (var topic of this_class.__topics_to_subscribe) {
                this_class.__subscribe(topic)
                this_class.__topics_subscribed.push(topic)
            }
            // there are message in the queue, send them
            if (this_class.__publish_queue.length > 0) { 
                for (var entry of this_class.__publish_queue) {
                    try {
                        this_class.__gateway.send(entry[0], entry[1], 2, entry[2])
                    } catch(e) {
                        this.__module.log_error("Unable to publish to topic "+topic+": "+get_exception(e))
                    }
                }
                this_class.__publish_queue = []
            }
        }
        
        // what to do on failure
        var __on_failure = function() {
            this_class.__module.log_error("Unable to connect to "+this_class.__module.gateway_hostname+":"+this_class.__module.gateway_port)
        }
        
        // connect to the gateway
        try {
            this.__module.log_debug("Connecting to "+this.__module.gateway_hostname+":"+this.__module.gateway_port+" (ssl="+this.__module.gateway_ssl+")")
            var connect_options = {
                "userName": this.__module.house_id,
                "password": this.__module.house_passcode,
                "onSuccess": __on_connect, 
                "onFailure": __on_failure, 
                "timeout": 2, 
                "useSSL": this.__module.gateway_ssl
            }
            this.__gateway.connect(connect_options)
        } catch(e) {
            this.__module.log_error("Unable to connect to "+this.__module.gateway_hostname+":"+this.__module.gateway_port+" "+get_exception(e))
        }
    }
    
    // subscribe to a given topic
    __subscribe(topic) {
        this.__module.log_debug("Subscribing topic "+topic)
        try {
            this.__gateway.subscribe(topic, {"qos": this.__module.gateway_qos_subscribe})
        } catch(e) {
            this.__module.log_error("Unable to subscribe to topic "+topic+": "+get_exception(e))
        }
    }
    
    // Build the full topic (e.g. egeoffrey/v1/<house_id>/<from_module>/<to_module>/<command>/<args>)
    __build_topic(house_id, from_module, to_module, command, args) {
        if (args == "") args = "null"
        return ["egeoffrey", "v"+this.__module.gateway_version, house_id, from_module, to_module, command, args].join("/")
    }
    
    // publish payload to a given topic (queue the message while offline)
    publish(house_id, to_module, command, args, payload_data, retain=false) {
        var payload = payload_data
        if (payload != null) payload = JSON.stringify(payload)
        else {
            var buffer = new ArrayBuffer(1)
            buffer[0] = null
            payload = buffer
        }
        var topic = this.__build_topic(house_id, this.__module.fullname, to_module, command, args)
        if (this.__module.connected) {
            try {
                this.__gateway.send(topic, payload, 2, retain=retain)
            } catch(e) {
                this.__module.log_error("Unable to publish to topic "+topic+": "+get_exception(e))
            }
        }
        else this.__publish_queue.push([topic, payload, retain])
    }
    
    // unsubscribe from a topic
    unsubscribe(topic) {
        this.__module.log_debug("Unsubscribing from "+topic)
        this.__topics_subscribed.remove(topic)
        try {
            this.__gateway.unsubscribe(topic)
        } catch(e) {
            this.__module.log_error("Unable to unsubscribe to topic "+topic+": "+get_exception(e))
        }
    }
    
    // connect to the MQTT broker and subscribed to the requested topics
    start() {
        // set client id . Format: egeoffrey-<house_id>-<scope>-<name>
        this.__client_id = ["egeoffrey", this.__module.house_id, this.__module.scope, this.__module.name].join("-")
        // get an instance of the MQTT client
        this.__gateway = new Paho.MQTT.Client(this.__module.gateway_hostname, Number(this.__module.gateway_port), this.__client_id);
        // define what to do upon connect
        var this_class = this
        var __on_connect = function(reconnect, url) {
            this_class.__module.log_debug("Connected to "+this_class.__module.gateway_hostname+":"+this_class.__module.gateway_port)
            this_class.__module.connected = true
            // subscribe to the requested topics
            for (var topic of this_class.__topics_to_subscribe) {
                this_class.__subscribe(topic)
                this_class.__topics_subscribed.push(topic)
            }
        }

        // what to do when receiving a message
        var __on_message = function(msg) {
            if (msg == null) return
            try {
                // parse the incoming request into a message data structure
                var message = new Message()
                message.parse(msg.destinationName, msg.payloadString, msg.retained, this_class.__module.gateway_version)
                if (this_class.__module.verbose) this_class.__module.log_debug("Received message "+message.dump(), false)
            } catch (e) {
                this_class.__module.log_error("Invalid message received on "+msg.destinationName+" - "+msg.payloadString+": "+get_exception(e))
                return
            }
            try {
                // identify the subscribed topic which caused this message to get here
                for (var pattern of this_class.__topics_subscribed) {
                    if (topic_matches_sub(pattern, message.topic)) {
                        // if the message is a configuration
                        if (message.sender == "controller/config" && message.command == "CONF") {
                            // notify the module about the configuration just received
                            try {
                                this_class.__module.on_configuration(message)
                            } catch(e) {
                                this_class.__module.log_error("runtime error during on_configuration() - "+message.dump()+": "+get_exception(e))
                                return
                            }
                            // check if we had to wait for this to start the module
                            var configuration_consumed = false
                            if (this_class.__topics_to_wait.length > 0) {
                                for (var req_pattern of this_class.__topics_to_wait) {
                                    // normalize the pattern so to match also configuration files received directly
                                    var req_pattern_normalized = req_pattern
                                    if (req_pattern.includes("*/*")) {
                                        req_pattern_normalized = req_pattern.replace("*/*","+/+")
                                    }
                                    // check if we were waiting for this file
                                    if (topic_matches_sub(req_pattern_normalized, message.topic)) {
                                        this_class.__module.log_debug("received configuration "+message.topic)
                                        var index = this_class.__topics_to_wait.indexOf(req_pattern)
                                        this_class.__topics_to_wait.splice(index, 1)
                                        // if there are no more topics to wait for, start the module
                                        if (this_class.__topics_to_wait.length == 0) { 
                                            this_class.__module.log_debug("Configuration completed for "+this_class.__module.fullname+", starting the module...")
                                            this_class.__module.configured = true
                                            // now that is configured, if there are configuration messages waiting in the queue, deliver them
                                            if (this_class.__configuration_queue.length > 0) { 
                                                for (var queued_message of this_class.__configuration_queue) {
                                                    try {
                                                        this_class.__module.on_configuration(queued_message)
                                                    } catch(e) {
                                                        this_class.__module.log_error("runtime error during on_configuration() - "+message.dump()+": "+get_exception(e))
                                                    }
                                                }
                                                this_class.__configuration_queue = []
                                            }
                                            // now that is configured, start the module
                                            try { 
                                                this_class.__module.on_start()
                                            } catch(e) {
                                                this_class.__module.log_error("runtime error during on_start(): "+get_exception(e))
                                            }
                                        } else {
                                            this_class.__module.log_debug("still waiting for configuration on "+JSON.stringify(this_class.__topics_to_wait))
                                        }
                                    }
                                }
                            }
                            // if this message was not consumed and the module is still unconfigured, queue it, will be delivered once configured
                            if (! configuration_consumed && ! this_class.__module.configured) {
                                this_class.__configuration_queue.push(message)
                            }
                        // handle internal messages
                        } else if (message.command == "PING") {
                            message.reply()
                            message.command = "PONG"
                            this_class.__module.send(message)
                        // controller/config acknowledged this subscribe request
                        } else if (message.sender == "controller/config" && message.command == "SUBSCRIBE_ACK") {
                                pattern = message.get_data()
                                if (this_class.pending_configurations.includes(pattern)) {
                                    this_class.pending_configurations.remove(pattern)
                                }
                        // notify the module about this message (only if fully configured)
                        } else {
                            if (this_class.__module.configured) {
                                try {
                                    this_class.__module.on_message(message)
                                } catch(e) {
                                    this_class.__module.log_error("runtime error during on_message(): "+get_exception(e))
                                }
                            }
                        }
                        // avoid delivering the same message multiple times for overlapping subscribers
                        return 
                    }
                }
            } catch(e) {
                this_class.__module.log_error("Cannot handle request: "+get_exception(e))
            }
        }

        // what to do upon disconnect
        var __on_disconnect = function(response) {
            this_class.__module.connected = false
            if (response.errorCode == 0) this_class.__module.log_debug("Disconnected from "+this_class.__module.gateway_hostname+":"+this_class.__module.gateway_port)
            else this_class.__module.log_warning("Unexpected disconnection")
            try {
                this_class.__module.on_disconnect()
            } catch(e) {
                this_class.__module.log_error("runtime error during on_disconnect(): "+get_exception(e))
            }
        }
        
        // configure callbacks
        this.__gateway.onMessageArrived = __on_message
        this.__gateway.onConnectionLost = __on_disconnect
        // connect to the gateway
        this.__connect({"userName": this.__module.house_id, "password": this.__module.house_passcode})
    }
    
    // add a listener for the given request
    add_listener(house_id, from_module, to_module, command, filter, wait_for_it) {
        var topic = this.__build_topic(house_id, from_module, to_module, command, filter)
        if (wait_for_it) {
            // if this is mandatory topic, unconfigure the module and add it to the list of topics to wait for
            if (wait_for_it) {
                this.__topics_to_wait.push(topic)
                this.__module.configured = false
                this.__module.log_debug("will wait for configuration on "+topic)
            }
        } 
        // subscribe the topic and keep track of it
        if (this.__module.connected) {
            if (this.__topics_subscribed.includes(topic)) return topic
            this.__subscribe(topic)
            this.__topics_subscribed.push(topic)
        }
        // if not connected, will subscribed once connected
        else {
            if (this.__topics_to_subscribe.includes(topic)) return topic
            this.__topics_to_subscribe.push(topic)
        }
        return topic
    }

    // add a configuration listener for the given request
    add_configuration_listener(house_id, args, wait_for_it) {
        // just wrap add_listener
        var topic = this.add_listener(house_id, "controller/config", "*/*", "CONF", args, wait_for_it)
        // if the config is not retained on the gateway, notify controller/config
        if (this.__module.gateway_version >= 2) {
            // add the configuration to the pending queue
            this.pending_configurations.push(args)
            // request the configuration files
            this.__send_configuration_request(args)
            // if not already running, schedule a job for periodically resending configuration requests in case controller/config has not responded
            if (this.pending_configurations_job == null) {
                this.pending_configurations_job = setInterval(function(this_class) {
                    return this_class.__resend_configuration_request()
                }(this), 2000);
            }
        }
        return topic
    }
    
    // disconnect from the MQTT broker
    stop() {
        if (this.__gateway == null) return
        try {
            if (this.__gateway.isConnected()) {
                this.__gateway.disconnect()
                try {
                    this.__module.on_disconnect()
                } catch(e) {
                    this_class.__module.log_error("runtime error during on_disconnect(): "+get_exception(e))
                }
            }
            this.__module.connected = false
        } catch(e) {
            this.__module.log_error("Unable to disconnect from "+this.__module.gateway_hostname+":"+this.__module.gateway_port+" "+get_exception(e))
        }
    }
}