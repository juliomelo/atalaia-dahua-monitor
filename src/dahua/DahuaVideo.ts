import DahuaConnection from './DahuaConnection.js'

export default class DahuaVideo {
    constructor(private readonly connection: DahuaConnection) { }
    
    async getChannels(): Promise<number> {
        const resp = await this.connection.get('/cgi-bin/devVideoInput.cgi', { action: 'getCollect' });
        const result = await resp.text();
        const m = /^result=(\d+)/.exec(result);

        if (!m) {
            throw new Error('Invalid format: ' + result);
        }

        return parseInt(m[1]);
    }
}