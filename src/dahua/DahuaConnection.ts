import DigestClient from 'digest-fetch';

export default class DahuaConnection {

    private readonly client: DigestClient;
    
    constructor(private url: string, username: string, password: string) {
        this.client = new DigestClient(username, password);
    }
 
    public async post(path: string, data: ReadableStream, query?: Record<string, string>) {
        const url = new URL(path, this.url);
        
        for (const key in query) {
            url.searchParams.append(key, query[key]);
        }

        const resp: Response = await this.client.fetch(url, { body: data } as RequestInit);

        if (!resp.ok) {
            throw new Error(`${resp.status} - ${await resp.text()}`);
        }
        
        return resp.json();
    }

    public async get(path: string, query?: Record<string, string>, signal?: AbortSignal) {
        const url = new URL(path, this.url);
        
        for (const key in query) {
            url.searchParams.append(key, query[key]);
        }

        const resp: Response = await this.client.fetch(url.toString(), signal ? { signal } as RequestInit : undefined);

        if (!resp.ok) {
            throw new Error(`${resp.status} - ${await resp.text()}`);
        }
        
        return resp;
    }

    public async getJson(path: string, query?: Record<string, string>) {
        const resp = await this.get(path, query);
        
        return resp.json();
    }
    
}