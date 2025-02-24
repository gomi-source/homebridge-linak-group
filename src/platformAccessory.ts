import bent from 'bent';

import { type CharacteristicValue, type PlatformAccessory, type Service } from 'homebridge';

import  { DeskGroupType, type DeskGroupPlatform } from './platform.js';


/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class DeskGroupAccessory {
  private service: Service;

  private deskStates = {
    CurrentPosition: 0,
    TargetPosition: 0,
  };

  private requestedPosTimer: string | number | NodeJS.Timeout | undefined;

  constructor(
    private readonly platform: DeskGroupPlatform,
    private readonly accessory: PlatformAccessory,
  ) {

    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Default-Manufacturer')
      .setCharacteristic(this.platform.Characteristic.Model, 'Default-Model')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, 'Default-Serial');

    // get the LightBulb service if it exists, otherwise create a new LightBulb service
    // you can create multiple services for each accessory
    this.service = this.accessory.getService(this.platform.Service.WindowCovering) || this.accessory.addService(this.platform.Service.WindowCovering);

    // set the service name, this is what is displayed as the default name on the Home app
    // in this example we are using the name we stored in the `accessory.context` in the `discoverDevices` method.
    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.name);

    // each service must implement at-minimum the "required characteristics" for the given service type
    // see https://developers.homebridge.io/#/service/WindowCovering

    this.service.getCharacteristic(this.platform.Characteristic.CurrentPosition)
      .onGet(this.getCurrentPosition.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.PositionState)
      .onGet(this.getPositionState.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.TargetPosition)
      .onGet(this.getTargetPosition.bind(this))
      .onSet(this.setTargetPosition.bind(this));

    // Initialize our state as stopped.
    // this.service.setCharacteristic(this.platform.Characteristic.PositionState, this.platform.Characteristic.PositionState.STOPPED);
    //this.service.getCharacteristic(this.platform.Characteristic.PositionState)
    //  .updateValue(this.platform.Characteristic.PositionState.STOPPED);

    /**
     * Creating multiple services of the same type.
     *
     * To avoid "Cannot add a Service with the same UUID another Service without also defining a unique 'subtype' property." error,
     * when creating multiple services of the same type, you need to use the following syntax to specify a name and subtype id:
     * this.accessory.getService('NAME') || this.accessory.addService(this.platform.Service.Lightbulb, 'NAME', 'USER_DEFINED_SUBTYPE_ID');
     *
     * The USER_DEFINED_SUBTYPE must be unique to the platform accessory (if you platform exposes multiple accessories, each accessory
     * can use the same subtype id.)
     */


    this.platform.log.debug('configuring desk: ', this.accessory.context.device);
  }

  PercentageToHeight(percentage: number) {
    percentage = percentage > 100 ? 100 : percentage < 0 ? 0 : percentage;
    const baseHeight = this.GetBaseHeightAndMovementRange().baseHeight;
    const movementRange = this.GetBaseHeightAndMovementRange().movementRange;

    return Math.round(percentage / 100 * movementRange + baseHeight);
  }

  HeightToPercentage(height: number) {
    const baseHeight = this.GetBaseHeightAndMovementRange().baseHeight;
    const movementRange = this.GetBaseHeightAndMovementRange().movementRange;

    let calculatedPercentage = Math.round((height - baseHeight) / movementRange * 100);
    calculatedPercentage = calculatedPercentage > 100 ? 100 : calculatedPercentage < 0 ? 0 : calculatedPercentage;
    return calculatedPercentage;
  }

  GetBaseHeightAndMovementRange() {
    let baseHeight = 540;
    let movementRange = 660;

    if (this.platform.config.baseHeight > 0) {
      baseHeight = this.platform.config.baseHeight;
    }

    if (this.platform.config.maxHeight > 0) {
      movementRange = this.platform.config.maxHeight - this.platform.config.baseHeight;
    }

    return {
      baseHeight: baseHeight,
      movementRange: movementRange,
    };
  }

  async moveToPercent(percentage: number) {
    const newHeight = this.PercentageToHeight(percentage);

    // Move by HTTP command
    const deskGroupType = this.accessory.context.device.desk_type === DeskGroupType.Group ? '/groups/' : '/desks/';

    const url = this.platform.config.sLinakServerBasePath + deskGroupType + this.accessory.context.device.id + '/height';
    const basic_auth_string = Buffer.from(this.platform.config.username + ':' + this.platform.config.password).toString('base64');
    const headers = {
      'Authorization': 'Basic ' + basic_auth_string,
    };

    const postJSON = bent('POST', 202);
    await postJSON(url, newHeight.toString(), headers);

    // Check if move is done by calling a GET endpoint (which is queued by the HTTP server)
    const deskId = this.accessory.context.device.desk_type === DeskGroupType.Group 
      ? this.accessory.context.device.desks[0].id 
      : this.accessory.context.device.id;
    const getUrl = this.platform.config.sLinakServerBasePath + '/desks/' + deskId + '/height';    
    const getJSON = bent('GET', 'json');
    await getJSON(getUrl, '', headers);

    this.deskStates.CurrentPosition = percentage;
    this.service.getCharacteristic(this.platform.Characteristic.CurrentPosition).updateValue(this.deskStates.CurrentPosition);

    this.service.getCharacteristic(this.platform.Characteristic.PositionState)
      .updateValue(this.platform.Characteristic.PositionState.STOPPED);

    this.platform.log.debug('Move finished to: ', percentage);
  }


  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, turning on a Light bulb.
   */

  /**
   * Handle requests to set the "Target Position" characteristic
   */
  async setTargetPosition(value: CharacteristicValue) {
    this.platform.log.debug('Triggered SET TargetPosition:', value);

    this.deskStates.TargetPosition = value as number;
    this.service.getCharacteristic(this.platform.Characteristic.TargetPosition).updateValue(this.deskStates.TargetPosition);

    clearTimeout(this.requestedPosTimer);
    this.requestedPosTimer = setTimeout(() => {
      this.platform.log.debug('executing move to: ', value);

      const moveUp = value as number > this.deskStates.TargetPosition;
      const positionState = moveUp ? this.platform.Characteristic.PositionState.INCREASING
        : this.platform.Characteristic.PositionState.DECREASING;

      // Tell HomeKit we're on the move.
      this.service.getCharacteristic(this.platform.Characteristic.PositionState).updateValue(positionState);

      setTimeout(() => this.moveToPercent(value as number), 100);

    }, 500);
  }

  /**
   * Handle the "GET" requests from HomeKit
   * These are sent when HomeKit wants to know the current state of the accessory, for example, checking if a Light bulb is on.
   *
   * GET requests should return as fast as possible. A long delay here will result in
   * HomeKit being unresponsive and a bad user experience in general.
   *
   * If your device takes time to respond you should update the status of your device
   * asynchronously instead using the `updateCharacteristic` method instead.
   * In this case, you may decide not to implement `onGet` handlers, which may speed up
   * the responsiveness of your device in the Home app.

   * @example
   * this.service.updateCharacteristic(this.platform.Characteristic.On, true)
   */

  /**
   * Handle requests to get the current value of the "Target Position" characteristic
   */
  async getTargetPosition(): Promise<CharacteristicValue> {
    this.platform.log.debug('Triggered GET TargetPosition');
    this.platform.log.debug(this.deskStates.TargetPosition.toString());
    
    return this.deskStates.TargetPosition;
  }

  /**
   * Handle requests to get the current value of the "Position State" characteristic
   */
  async getPositionState(): Promise<CharacteristicValue> {
    this.platform.log.debug('Triggered GET PositionState');

    // set this to a valid value for PositionState
    const moveUp = this.deskStates.CurrentPosition > this.deskStates.TargetPosition;
    return moveUp 
      ? this.platform.Characteristic.PositionState.INCREASING
      : this.deskStates.CurrentPosition < this.deskStates.TargetPosition 
        ? this.platform.Characteristic.PositionState.DECREASING 
        : this.platform.Characteristic.PositionState.STOPPED;
  }

  /**
     * Handle requests to get the current value of the "Current Position" characteristic
     */
  async getCurrentPosition(): Promise<CharacteristicValue> {
    this.platform.log.debug('Triggered GET CurrentPosition');
    // setTimeout(() => this.poll(), 100);

    // Get height from HTTP server
    const deskId = this.accessory.context.device.desk_type === DeskGroupType.Group 
      ? this.accessory.context.device.desks[0].id
      : this.accessory.context.device.id;
    const url = this.platform.config.sLinakServerBasePath + '/desks/' + deskId + '/height';    
    const basic_auth_string = Buffer.from(this.platform.config.username + ':' + this.platform.config.password).toString('base64');
    const headers = {
      'Authorization': 'Basic ' + basic_auth_string,
    };

    const get = bent('GET', 'json');
    const response = await get(url, '', headers);

    this.deskStates.CurrentPosition = this.HeightToPercentage(response as number);
    // This the desk can be moved outside of homekit, TargetPosition has to be updated to match:
    this.deskStates.TargetPosition = this.deskStates.CurrentPosition;
    this.service.updateCharacteristic(this.platform.Characteristic.TargetPosition, this.deskStates.TargetPosition);
    
    // if you need to return an error to show the device as "Not Responding" in the Home app:
    // throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    this.platform.log.debug(this.deskStates.CurrentPosition.toString());

    return this.deskStates.CurrentPosition;
  }
}

export class ExamplePlatformAccessory {
  private service: Service;

  /**
   * These are just used to create a working example
   * You should implement your own code to track the state of your accessory
   */
  private exampleStates = {
    On: false,
    Brightness: 100,
  };

  constructor(
    private readonly platform: DeskGroupPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Default-Manufacturer')
      .setCharacteristic(this.platform.Characteristic.Model, 'Default-Model')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, 'Default-Serial');

    // get the LightBulb service if it exists, otherwise create a new LightBulb service
    // you can create multiple services for each accessory

    /*
    if (accessory.context.device.CustomService) {
      /* This is only required when using Custom Services and Characteristics not support by HomeKit
      this.service = this.accessory.getService(this.platform.CustomServices[accessory.context.device.CustomService]) ||
        this.accessory.addService(this.platform.CustomServices[accessory.context.device.CustomService]);
      
    } else {
    */
    this.service = this.accessory.getService(this.platform.Service.Lightbulb) || this.accessory.addService(this.platform.Service.Lightbulb);
    //}

    // set the service name, this is what is displayed as the default name on the Home app
    // in this example we are using the name we stored in the `accessory.context` in the `discoverDevices` method.
    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.name); // accessory.context.device.exampleDisplayName);

    // each service must implement at-minimum the "required characteristics" for the given service type
    // see https://developers.homebridge.io/#/service/Lightbulb

    // register handlers for the On/Off Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setOn.bind(this)) // SET - bind to the `setOn` method below
      .onGet(this.getOn.bind(this)); // GET - bind to the `getOn` method below

    // register handlers for the Brightness Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.Brightness)
      .onSet(this.setBrightness.bind(this)); // SET - bind to the `setBrightness` method below

    /**
     * Creating multiple services of the same type.
     *
     * To avoid "Cannot add a Service with the same UUID another Service without also defining a unique 'subtype' property." error,
     * when creating multiple services of the same type, you need to use the following syntax to specify a name and subtype id:
     * this.accessory.getService('NAME') || this.accessory.addService(this.platform.Service.Lightbulb, 'NAME', 'USER_DEFINED_SUBTYPE_ID');
     *
     * The USER_DEFINED_SUBTYPE must be unique to the platform accessory (if you platform exposes multiple accessories, each accessory
     * can use the same subtype id.)
     */

    // Example: add two "motion sensor" services to the accessory
    const motionSensorOneService = this.accessory.getService('Motion Sensor One Name')
      || this.accessory.addService(this.platform.Service.MotionSensor, 'Motion Sensor One Name', 'YourUniqueIdentifier-1');

    const motionSensorTwoService = this.accessory.getService('Motion Sensor Two Name')
      || this.accessory.addService(this.platform.Service.MotionSensor, 'Motion Sensor Two Name', 'YourUniqueIdentifier-2');

    /**
     * Updating characteristics values asynchronously.
     *
     * Example showing how to update the state of a Characteristic asynchronously instead
     * of using the `on('get')` handlers.
     * Here we change update the motion sensor trigger states on and off every 10 seconds
     * the `updateCharacteristic` method.
     *
     */
    let motionDetected = false;
    setInterval(() => {
      // EXAMPLE - inverse the trigger
      motionDetected = !motionDetected;

      // push the new value to HomeKit
      motionSensorOneService.updateCharacteristic(this.platform.Characteristic.MotionDetected, motionDetected);
      motionSensorTwoService.updateCharacteristic(this.platform.Characteristic.MotionDetected, !motionDetected);

      this.platform.log.debug('Triggering motionSensorOneService:', motionDetected);
      this.platform.log.debug('Triggering motionSensorTwoService:', !motionDetected);
    }, 10000);
  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, turning on a Light bulb.
   */
  async setOn(value: CharacteristicValue) {
    // implement your own code to turn your device on/off
    this.exampleStates.On = value as boolean;

    this.platform.log.debug('Set Characteristic On ->', value);
  }

  /**
   * Handle the "GET" requests from HomeKit
   * These are sent when HomeKit wants to know the current state of the accessory, for example, checking if a Light bulb is on.
   *
   * GET requests should return as fast as possible. A long delay here will result in
   * HomeKit being unresponsive and a bad user experience in general.
   *
   * If your device takes time to respond you should update the status of your device
   * asynchronously instead using the `updateCharacteristic` method instead.
   * In this case, you may decide not to implement `onGet` handlers, which may speed up
   * the responsiveness of your device in the Home app.

   * @example
   * this.service.updateCharacteristic(this.platform.Characteristic.On, true)
   */
  async getOn(): Promise<CharacteristicValue> {
    // implement your own code to check if the device is on
    const isOn = this.exampleStates.On;

    this.platform.log.debug('Get Characteristic On ->', isOn);

    // if you need to return an error to show the device as "Not Responding" in the Home app:
    // throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);

    return isOn;
  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, changing the Brightness
   */
  async setBrightness(value: CharacteristicValue) {
    // implement your own code to set the brightness
    this.exampleStates.Brightness = value as number;

    this.platform.log.debug('Set Characteristic Brightness -> ', value);
  }
}
