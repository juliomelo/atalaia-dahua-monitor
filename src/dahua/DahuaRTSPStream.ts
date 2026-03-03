export interface DahuaRTSPStreamConfig {
    host: string;
    username: string;
    password: string;
    channel: number;
    subtype?: 0 | 1 | 2;
    port?: number;
}

export default class DahuaRTSPStream {
    private readonly rtspUrl: string;
    private readonly transport: 'tcp' | 'udp';

    constructor(rtspUrl: string, transport: 'tcp' | 'udp' = 'tcp') {
        this.rtspUrl = rtspUrl;
        this.transport = transport;
    }

    static fromDahuaConfig({
        host,
        username,
        password,
        channel,
        subtype = 0,
        port = 554
    }: DahuaRTSPStreamConfig): DahuaRTSPStream {
        const auth = `${encodeURIComponent(username)}:${encodeURIComponent(password)}`;
        const normalizedHost = host.replace(/^https?:\/\//, '').replace(/\/+$/, '');
        const url = `rtsp://${auth}@${normalizedHost}:${port}/cam/realmonitor?channel=${channel}&subtype=${subtype}`;
        return new DahuaRTSPStream(url);
    }

    public getUrl(): string {
        return this.rtspUrl;
    }

    public getFFmpegInputArgs(): string[] {
        return ['-rtsp_transport', this.transport, '-i', this.rtspUrl];
    }
}