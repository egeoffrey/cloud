### Module class from which all the components inherits common functionalities
## DEPENDENCIES:
# OS:
# Python: 

import sys
reload(sys)  
sys.setdefaultencoding('utf8')

import os
import time
import datetime
import threading
from abc import ABCMeta, abstractmethod

from sdk.python.module.helpers.message import Message
from sdk.python.module.helpers.mqtt_client import Mqtt_client
from sdk.python.module.helpers.scheduler import Scheduler
from sdk.python.module.helpers.session import Session
import sdk.python.utils.exceptions as exception
import sdk.python.utils.strings

class Module(threading.Thread):
    # used for enforcing abstract methods
    __metaclass__ = ABCMeta 
    
    # initialize the class and set the variables
    def __init__(self, scope, name):
        # thread init
        super(Module, self).__init__()
        # set name of this module
        self.scope = scope
        self.name = name
        self.fullname = scope+"/"+name
        self.watchdog = None
        # module version and build (will be set by the watchdog)
        self.version = None
        self.build = None
        # gateway settings
        self.gateway_hostname = os.getenv("EGEOFFREY_GATEWAY_HOSTNAME", "egeoffrey-gateway")
        self.gateway_port = int(os.getenv("EGEOFFREY_GATEWAY_PORT", 443))
        self.gateway_transport = os.getenv("EGEOFFREY_GATEWAY_TRANSPORT", "websockets")
        self.gateway_ssl = bool(int(os.getenv("EGEOFFREY_GATEWAY_SSL", False)))
        self.gateway_ca_cert = os.getenv("EGEOFFREY_GATEWAY_CA_CERT", "/etc/ssl/certs")
        self.gateway_certfile = os.getenv("EGEOFFREY_GATEWAY_CERTFILE", None)
        self.gateway_keyfile = os.getenv("EGEOFFREY_GATEWAY_KEYFILE", None)
        self.gateway_qos_subscribe = os.getenv("EGEOFFREY_GATEWAY_QOS_SUBSCRIBE", 2)
        self.gateway_qos_publish = os.getenv("EGEOFFREY_GATEWAY_QOS_PUBLISH", 2)
        self.gateway_version = os.getenv("EGEOFFREY_GATEWAY_VERSION", 1)
        # house settings
        self.house_id = os.getenv("EGEOFFREY_ID", "house")
        self.house_passcode = os.getenv("EGEOFFREY_PASSCODE", "")
        # debug
        self.debug = bool(int(os.getenv("EGEOFFREY_DEBUG", False)))
        self.verbose = bool(int(os.getenv("EGEOFFREY_VERBOSE", False)))
        # logging
        self.logging_remote = bool(int(os.getenv("EGEOFFREY_LOGGING_REMOTE", True)))
        self.logging_local = bool(int(os.getenv("EGEOFFREY_LOGGING_LOCAL", True)))
        # scheduler
        self.scheduler = None
        # status
        self.connected = False
        self.configured = True # by default no configuration is required to start
        self.stopping = False
        # initialize mqtt client for connecting to the bus
        self.__mqtt = Mqtt_client(self)
        # make the mqtt client persistent (will buffer messages when offline)
        self.persistent_client = bool(int(os.getenv("EGEOFFREY_PERSISTENT_CLIENT", False)))
        # initialize session manager
        self.sessions = Session(self)
        # call module implementation of init
        try:
            self.log_debug("Initializing module...")
            self.on_init()
        except Exception,e: 
            self.log_error("runtime error during on_init(): "+exception.get(e))

    # Add a listener for the given configuration request (will call on_configuration())
    def add_configuration_listener(self, args, version=None, wait_for_it=False):
        filename = args if version is None else str(version)+"/"+args
        return self.__mqtt.add_configuration_listener(self.house_id, filename, wait_for_it)

    # add a listener for the messages addressed to this module (will call on_message())
    def add_request_listener(self, from_module, command, args):
        return self.__mqtt.add_listener(self.house_id, from_module, self.fullname, command, args, False)
    
    # add a listener for broadcasted messages from the given module (will call on_message())
    def add_broadcast_listener(self, from_module, command, args):
        return self.__mqtt.add_listener(self.house_id, from_module, "*/*", command, args, False)

    # add a listner for broadcasted manifests (will call on_message())
    def add_manifest_listener(self, from_module="+/+"):
        # add a broadcast listener for the manifest
        topic = self.add_broadcast_listener(from_module, "MANIFEST", "#")
        # if manifests are not supposed to be retained on the bus, ask them explicitely by broadcasting a request
        if self.gateway_version >= 2:
            recipient = "*/*" if from_module == "+/+" else from_module
            message = Message(self)
            message.recipient = recipient
            message.command = "REQ_MANIFEST"
            self.send(message)
        return topic

    # add a listener for intercepting messages from a given module to a given module (will call on_message())
    def add_inspection_listener(self, from_module, to_module, command, args):
        return self.__mqtt.add_listener(self.house_id, from_module, to_module, command, args, False)
    
    # remove a topic previously subscribed
    def remove_listener(self, topic):
        self.__mqtt.unsubscribe(topic)
        
    # send a message to another module
    def send(self, message):
        if self.verbose: self.log_debug("Publishing message "+message.dump(), False)
        # ensure message is valid
        if message.sender == "" or message.sender == "*/*" or message.recipient == "" or message.command == "" or message.house_id == "":
            self.log_warning("invalid message to send: "+message.dump(), False)
            return
        # prepare config version if any
        if message.config_schema is not None:
            message.args = str(message.config_schema)+"/"+message.args
        # prepare payload
        if message.is_null: payload = None 
        else: payload = message.get_payload()
        # publish it to the message bus
        self.__mqtt.publish(message.house_id, message.recipient, message.command, message.args, payload, message.retain)
        
    # log a message
    def __log(self, severity, text, allow_remote_logging):
        if self.logging_local:
            print sdk.python.utils.strings.format_log_line(severity, self.fullname, text)
        if self.logging_remote and allow_remote_logging:
            # send the message to the logger module
            message = Message(self)
            message.recipient = "controller/logger"
            message.command = "LOG"
            message.args = severity
            message.set_data(text)
            self.send(message)

    # handle debug logs
    def log_debug(self, text, allow_remote_logging=True):
        if not self.debug: return
        self.__log("debug", text, allow_remote_logging)
    
    # handle info logs
    def log_info(self, text, allow_remote_logging=True):
        self.__log("info", text, allow_remote_logging)
    
    # handle warning logs
    def log_warning(self, text, allow_remote_logging=True):
        self.__log("warning", text, allow_remote_logging)
    
    # handle error logs
    def log_error(self, text, allow_remote_logging=True):
        self.__log("error", text, allow_remote_logging)

    # ensure all the items of an array of settings are included in the configuration object provided
    def is_valid_configuration(self, settings, configuration):
        if not isinstance(configuration, dict): return False
        # for Service and Interaction subclasses, return false if there is a "disabled" attribute set
        for base in self.__class__.__bases__:
            if base.__name__ in ["Service", "Interaction"] and "disabled" in configuration and configuration["disabled"]:
                self.log_debug("module disabled by configuration")
                return False
        # for every mandatory parameter, return false if not available
        for item in settings:
            if not item in configuration or configuration[item] is None: 
                self.log_warning("Invalid configuration received, "+item+" missing in "+str(configuration))
                return False
        return True
    
    # wrap around time sleep so to break if the module is stopping
    def sleep(self, sleep_time):
        step = 0.5
        slept = 0
        if sleep_time < step: step = sleep_time
        while (slept <= sleep_time):
            if self.stopping: break
            time.sleep(step)
            slept = slept+step
            
    # upgrade a configuration file to the given version
    def upgrade_config(self, filename, from_version, to_version, content):
        # delete the old configuration file first
        message = Message(self)
        message.recipient = "controller/config"
        message.command = "DELETE"
        message.args = filename
        message.config_schema = from_version
        self.send(message)
        # save the new version
        message = Message(self)
        message.recipient = "controller/config"
        message.command = "SAVE"
        message.args = filename
        message.config_schema = to_version
        message.set_data(content)
        self.send(message)
        self.log_info("Requesting to upgrade configuration "+filename+" from v"+str(from_version)+" to v"+str(to_version))
    
    # run the module, called when starting the thread
    def run(self):
        build = " (build "+self.build+")" if self.build is not None else ""
        self.log_info("Starting module"+build)
        # connect to the mqtt broker
        self.__mqtt.start()
        # subscribe to any request addressed to this module  
        self.add_request_listener("+/+", "+", "#")
        # tell everybody this module has started
        message = Message(self)
        message.recipient = "*/*"
        message.command = "STATUS"
        message.args = "1"
        self.send(message)
        # if the service is not configured (waiting for a configuration file), sleep until it will be
        while not self.configured:
            self.sleep(1)
        # run the user's callback if configured, otherwise will be started once all the required configuration will be received
        try: 
            self.on_pre_start()
            self.on_start()
            self.on_post_start()
        except Exception,e: 
            self.log_error("runtime error during on_start(): "+exception.get(e))

    # shut down the module, called when stopping the thread
    def join(self):
        self.log_info("Stopping module...")
        self.stopping = True
        # tell everybody this module has stopped
        message = Message(self)
        message.recipient = "*/*"
        message.command = "STATUS"
        message.args = "0"
        self.send(message)
        self.on_stop()
        self.__mqtt.stop()
        
    # What to do when initializing (subclass has to implement)
    @abstractmethod
    def on_init(self):
        pass
        
    # What to do just after connecting (subclass may implement)
    def on_connect(self):
        pass
        
    # What to do just before starting (subclass may implement)
    def on_pre_start(self):
        pass
        
    # What to do when starting (subclass has to implement)
    @abstractmethod
    def on_start(self):
        pass
        
    # What to do just after starting (subclass may implement)
    def on_post_start(self):
        pass

    # What to do when shutting down (subclass has to implement)
    @abstractmethod
    def on_stop(self):
        pass
        
    # What to do just after disconnecting (subclass may implement)
    def on_disconnect(self):
        pass

    # What to do when receiving a request for this module (subclass has to implement)
    @abstractmethod
    def on_message(self, message):
        pass

     # What to do when receiving a new/updated configuration for this module (subclass has to implement)
    @abstractmethod
    def on_configuration(self, message):
        pass

