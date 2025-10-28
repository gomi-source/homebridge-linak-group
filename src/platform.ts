import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';

import { DeskGroupAccessory } from './platformAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

import bent from 'bent';

// This is only required when using Custom Services and Characteristics not support by HomeKit
// import { EveHomeKitTypes } from 'homebridge-lib/EveHomeKitTypes';

/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class DeskGroupPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: Map<string, PlatformAccessory> = new Map();
  public readonly discoveredCacheUUIDs: string[] = [];

  // This is only required when using Custom Services and Characteristics not support by HomeKit
   
  // public readonly CustomServices: any;
   
  // public readonly CustomCharacteristics: any;

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    // This is only required when using Custom Services and Characteristics not support by HomeKit
    // this.CustomServices = new EveHomeKitTypes(this.api).Services;
    // this.CustomCharacteristics = new EveHomeKitTypes(this.api).Characteristics;

    // MY CODE START

    // No configuration found - we won't start.
    if(!config) {
      return;
    }

    // If we don't have any HTTP server configured, we're done here.
    if(!config.sLinakServerBasePath) {
      this.log.error('No desk group server path has been configured.');
      return;
    }

    if (config.maxHeight < config.baseHeight) {
      this.log.error('The max height must be higher than the base height.');
      return;
    }

    // MY CODE STOP

    this.log.debug('Finished initializing platform:', this.config.name);

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      // run the method to discover / register your devices as accessories
      this.discoverDevices();
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to set up event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    // add the restored accessory to the accessories cache, so we can track if it has already been registered
    this.accessories.set(accessory.UUID, accessory);
  }

  /**
   * This is an example method showing how to register discovered accessories.
   * Accessories must only be registered once, previously created accessories
   * must not be registered again to prevent "duplicate UUID" errors.
   */
  async discoverDevices() {
    // Query REST API for devices
    let deskGroups = await this.GetGroups();
    if (this.config.addIndividualDesks) {
      const desks = await this.GetDesks();
      deskGroups = [...deskGroups, ...desks];
    }
    
    /* EXAMPLE ONLY
    // A real plugin you would discover accessories from the local network, cloud services
    // or a user-defined array in the platform config.
    const exampleDevices = [
      {
        exampleUniqueId: 'ABCD',
        exampleDisplayName: 'Bedroom',
      },
      {
        exampleUniqueId: 'EFGH',
        exampleDisplayName: 'Kitchen',
      },
      {
        // This is an example of a device which uses a Custom Service
        exampleUniqueId: 'IJKL',
        exampleDisplayName: 'Backyard',
        CustomService: 'AirPressureSensor',
      },
    ];
    */
    // loop over the discovered devices and register each one if it has not already been registered
    console.debug('************ DISCOVERED GROUPS ************');
    console.debug(deskGroups);
    // console.log(myVal);
    for (const device of deskGroups) {
      // generate a unique id for the accessory this should be generated from
      // something globally unique, but constant, for example, the device serial
      // number or MAC address
      const uuid = this.api.hap.uuid.generate(device.id);

      // see if an accessory with the same uuid has already been registered and restored from
      // the cached devices we stored in the `configureAccessory` method above
      const existingAccessory = this.accessories.get(uuid);

      if (existingAccessory) {
        // the accessory already exists
        this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);

        // if you need to update the accessory.context then you should run `api.updatePlatformAccessories`. e.g.:
        // existingAccessory.context.device = device;
        // this.api.updatePlatformAccessories([existingAccessory]);

        // create the accessory handler for the restored accessory
        // this is imported from `platformAccessory.ts`
        new DeskGroupAccessory(this, existingAccessory);

        // it is possible to remove platform accessories at any time using `api.unregisterPlatformAccessories`, e.g.:
        // remove platform accessories when no longer present
        // this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existingAccessory]);
        // this.log.info('Removing existing accessory from cache:', existingAccessory.displayName);
      } else {
        // the accessory does not yet exist, so we need to create it
        this.log.info('Adding new accessory:', device.name);

        // create a new accessory
        const accessory = new this.api.platformAccessory(device.name, uuid);

        // store a copy of the device object in the `accessory.context`
        // the `context` property can be used to store any data about the accessory you may need
        accessory.context.device = device;

        // create the accessory handler for the newly create accessory
        // this is imported from `platformAccessory.ts`
        new DeskGroupAccessory(this, accessory);

        // link the accessory to your platform
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }

      // push into discoveredCacheUUIDs
      this.discoveredCacheUUIDs.push(uuid);
    }

    // you can also deal with accessories from the cache which are no longer present by removing them from Homebridge
    // for example, if your plugin logs into a cloud account to retrieve a device list, and a user has previously removed a device
    // from this cloud account, then this device will no longer be present in the device list but will still be in the Homebridge cache
    for (const [uuid, accessory] of this.accessories) {
      if (!this.discoveredCacheUUIDs.includes(uuid)) {
        this.log.info('Removing existing accessory from cache:', accessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
  }

  async GetGroups(): Promise<DeskGroup[]> {
    const deskGroups: DeskGroup[] = [];

    const basic_auth_string = Buffer.from(this.config.username + ':' + this.config.password).toString('base64');
    const headers = {
      'Authorization': 'Basic ' + basic_auth_string,
    };

    const getJSON = bent('json');
    const groupData = await getJSON(this.config.sLinakServerBasePath + '/groups', '', headers);

    for (const group_id in groupData) {
      const group_members: string[] = groupData[group_id];
      console.debug(group_id);  // "office"
      console.debug(group_members);  // array of desk_id

      const deskGroup = new DeskGroup(group_id, group_id, groupData[group_id]);

      // Query for info on desks in group
      for (const desk_id of group_members) {
        console.debug(desk_id);
        const deskData = await getJSON(this.config.sLinakServerBasePath + '/desks/' + desk_id, '', headers);
        console.debug(deskData);
        deskGroup.desks.push(deskData);
      }
      
      deskGroups.push(deskGroup);
    }

    return deskGroups;
  }

  async GetDesks(): Promise<Desk[]> {
    const desks: Desk[] = [];

    const basic_auth_string = Buffer.from(this.config.username + ':' + this.config.password).toString('base64');
    const headers = {
      'Authorization': 'Basic ' + basic_auth_string,
    };

    const getJSON = bent('json');
    const response = await getJSON(this.config.sLinakServerBasePath + '/desks', '', headers);
    // forEach (const desk_id in desks.entries) {
    for (let i = 0; i < response.length; i++) {
      const desk = new Desk(response[i].id, response[i].config_name, response[i].height, response[i].base_height);
      desks.push(desk);
    }

    return desks;
  }
}

export class DeskGroup {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public desks: any = [];

  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly mac_ids: string[],
    public readonly desk_type: DeskGroupType = DeskGroupType.Group,
  ) {
    this.id = id;
    this.name = name;
    this.mac_ids = mac_ids;
    this.desk_type = desk_type;
  }
}

export class Desk extends DeskGroup {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public desk: any;

  constructor(
    public readonly id: string,
    public readonly config_name: string,
    public readonly height: number,
    public readonly base_height: number,
  ) {
    super(id, config_name, [], DeskGroupType.Individual);
    this.height = height;
    this.base_height = base_height;
  }
}

export enum DeskGroupType {
  Group,
  Individual
}
