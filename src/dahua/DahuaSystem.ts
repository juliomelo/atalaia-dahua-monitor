import DahuaConnection from './DahuaConnection.js';

export default class DahuaSystem {
    constructor(private readonly connection: DahuaConnection) { }
    
    async getMachineName(): Promise<string> {
        const resp = await this.connection.get('/cgi-bin/magicBox.cgi', { action: 'getMachineName' });
        return resp.text();
    }

    async getVendor(): Promise<string> {
        const resp = await this.connection.get('/cgi-bin/magicBox.cgi', { action: 'getVendor' });
        return (await resp.text()).replace(/^vendor=/, '');
    }

    async getDeviceType(): Promise<string> {
        const resp = await this.connection.get('/cgi-bin/magicBox.cgi', { action: 'getDeviceType' });
        return (await resp.text()).replace(/^type=/, '');
    }

    async getHardwareVersion(): Promise<string> {
        const resp = await this.connection.get('/cgi-bin/magicBox.cgi', { action: 'getHardwareVersion' });
        return (await resp.text()).replace(/^version=/, '');
    }

    async getSerialNumber(): Promise<string> {
        const resp = await this.connection.get('/cgi-bin/magicBox.cgi', { action: 'getSerialNo' });
        return (await resp.text()).replace(/^sn=/, '');
    }

}