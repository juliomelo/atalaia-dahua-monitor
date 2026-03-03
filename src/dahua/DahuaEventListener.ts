import DahuaConnection from './DahuaConnection.js';

export enum DahuaAction {
    START = 'start',
    STOP = 'stop',
    PULSE = 'pulse'
}

export type DahuaEventCallback<T> =
    ((action: DahuaAction, index: number, data: T) => void);

interface ICallbacks {
    [idx: string]: DahuaEventCallback<object>[];
}

export default class DahuaEventListener {

    private readonly callbacks: ICallbacks = {};
    private readonly ignoredEvents = new Set<string>();

    constructor(private readonly connection: DahuaConnection, private readonly events = ['All']) {
        this.connect().catch(e => {
            console.error('Falha na monitração de eventos da Dahua.', e);
            process.exit(-1);
        });
        this.callbacks.RecordDelete = [];
        this.callbacks.AlarmUserLogin = [];
        this.callbacks.InterVideoAccess = [];
    }

    addEventListener(event: 'VideoMotion', callback: DahuaEventCallback<IVideoMotion>): void;
    addEventListener(event: 'SmartMotionVehicle', callback: DahuaEventCallback<ISmartMotionVehicle>): void;
    addEventListener(event: 'SmartMotionHuman', callback: DahuaEventCallback<ISmartMotionHuman>): void;
    addEventListener(event: string, callback: DahuaEventCallback<any>): void {
        if (event in this.callbacks) {
            this.callbacks[event].push(callback);
        } else {
            this.callbacks[event] = [callback];
        }
    }

    private async connect(): Promise<void> {
        const path = '/cgi-bin/eventManager.cgi';

        const resp = await this.connection.get(path, {
            action: 'attach',
            codes: `[${this.events.join(',')}]`,
            heartbeat: '60'
        });

        if (!resp.body) {
            throw new Error('No body.');
        }

        const contentType = resp.headers.get('content-type');

        if (!contentType) {
            throw new Error('Response did not provide content-type.');
        }

        const m = /; boundary=([^;]+)/.exec(contentType)

        if (!m) {
            throw new Error('Unexpected format.');
        }

        const boundary = m[1];

        const reader = resp.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        console.info('Connected to Dahua event manager, waiting for events...');

        while (true) {
            const { done, value } = await reader.read();
            
            if (done) throw new Error('Disconnected from Dahua event manager.');

            buffer += decoder.decode(value, { stream: true });

            // While there is a boundary in the buffer, process it
            let boundaryIndex;
            const boundaryMarker = `--${boundary}`;
            while ((boundaryIndex = buffer.indexOf(boundaryMarker)) !== -1) {
                const part = buffer.slice(0, boundaryIndex);
                buffer = buffer.slice(boundaryIndex + boundaryMarker.length);

                if (part.trim()) {
                    // Remove headers from the part (if any) and get the body
                    const [headers, ...bodyLines] = part.split('\r\n\r\n');
                    const body = bodyLines.join('\r\n\r\n').trim();

                    // Call the callback with the received data
                    this.onChunk(body, headers);
                }
            }
        }
    }

    private onChunk(body: string, headers: string) {
        const m = /^Code=([^;]+);action=([^;]+);index=(\d+)(?:;(!:data).+?)?(?:;data=({.*}))?/ims.exec(body);

        if (!m) {
            if (body === 'Heartbeat') {
                return;
            }

            console.warn('Unsupported format:', body);
            return;
        }

        const [, code, action, index /* channel? */, , data] = m;
        const callbacks = this.callbacks[code];

        if (!callbacks) {
            if (!this.ignoredEvents.has(code)) {
                this.ignoredEvents.add(code);
                console.warn(`Ignored event for code ${code}:`, body);
            }
            return;
        }

        const json = data ? JSON.parse(data) : undefined;

        callbacks.forEach(callback => callback(action.toLowerCase() as DahuaAction, parseInt(index), json));
    }
}

export interface IVideoMotion {
    SmartMotionEnable: boolean;
}

export interface ISmartMotionVehicle {
    object: {
        Rect: number[];
        VehicleID: number;
    }
}

export interface ISmartMotionHuman {
    object: {
        HumanID: number;
        Rect: number[];
    }
}