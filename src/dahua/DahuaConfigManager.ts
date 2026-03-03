import DahuaConnection from './DahuaConnection';

export default class DahuaConfigManager {

    constructor(private readonly connection: DahuaConnection) { }

    async getChannelTitle(): Promise<string[]> {
        const resp = await (await this.connection.get('cgi-bin/configManager.cgi?action=getConfig&name=ChannelTitle')).text();
        const regexp = /^table.ChannelTitle\[(\d+)\]\.Name=(.+)$/gm;

        const titles: string[] = [];
        let match: RegExpExecArray | null;

        while ((match = regexp.exec(resp)) !== null) {
            const index = parseInt(match[1], 10);
            const title = match[2];
            titles[index] = title;
        }

        return titles;
    }
}