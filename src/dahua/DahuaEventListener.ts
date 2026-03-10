import DahuaConnection from './DahuaConnection.js';
import { debugLog } from '../debug.js';

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
    
    // Controle de HeartBeat
    private lastHeartbeatTime: number = Date.now();
    private heartbeatHistory: number[] = [];
    private expectedHeartbeatInterval: number = 60_000 * 5; // Valor inicial de 5 minutos
    private heartbeatCheckTimer?: NodeJS.Timeout;
    private isReconnecting = false;

    constructor(private readonly connection: DahuaConnection, private readonly events = ['All']) {
        this.connect().catch(e => {
            console.error('Falha na monitração de eventos da Dahua.', e);
            process.exit(-1);
        });
        this.callbacks.RecordDelete = [];
        this.callbacks.AlarmUserLogin = [];
        this.callbacks.InterVideoAccess = [];
        
        // Inicia o monitoramento de HeartBeat
        this.startHeartbeatMonitoring();
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

    public dispose() {
        if (this.heartbeatCheckTimer) {
            clearInterval(this.heartbeatCheckTimer);
            this.heartbeatCheckTimer = undefined;
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
                this.onHeartbeat();
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

    private onHeartbeat() {
        const now = Date.now();
        const interval = now - this.lastHeartbeatTime;
        
        // Adiciona o intervalo ao histórico (mantém últimos 10 heartbeats)
        if (this.heartbeatHistory.length > 0) { // Ignora o primeiro intervalo
            this.heartbeatHistory.push(interval);
            if (this.heartbeatHistory.length > 10) {
                this.heartbeatHistory.shift();
            }
            
            // Calcula a média do intervalo
            const avgInterval = this.heartbeatHistory.reduce((a, b) => a + b, 0) / this.heartbeatHistory.length;
            this.expectedHeartbeatInterval = avgInterval;
            
            debugLog(`HeartBeat recebido. Intervalo: ${(interval / 1000).toFixed(1)}s, Média: ${(avgInterval / 1000).toFixed(1)}s`);
        } else {
            debugLog('Primeiro HeartBeat recebido');
        }
        
        this.lastHeartbeatTime = now;
    }

    private startHeartbeatMonitoring() {
        // Verifica a cada 10 segundos se o HeartBeat está sendo recebido
        this.heartbeatCheckTimer = setInterval(() => {
            this.checkHeartbeatTimeout();
        }, 10000);
    }

    private checkHeartbeatTimeout() {
        if (this.isReconnecting) {
            return;
        }

        const now = Date.now();
        const timeSinceLastHeartbeat = now - this.lastHeartbeatTime;
        const maxAllowedInterval = this.expectedHeartbeatInterval * 2;

        if (timeSinceLastHeartbeat > maxAllowedInterval) {
            console.warn(
                `HeartBeat não recebido há ${(timeSinceLastHeartbeat / 1000).toFixed(1)}s ` +
                `(esperado: ${(this.expectedHeartbeatInterval / 1000).toFixed(1)}s, ` +
                `limite: ${(maxAllowedInterval / 1000).toFixed(1)}s). Iniciando reconexão...`
            );
            this.reconnect();
        }
    }

    private async reconnect() {
        if (this.isReconnecting) {
            return;
        }

        this.isReconnecting = true;
        
        try {
            console.info('Reconectando ao Dahua Event Manager...');
            
            // Limpa o histórico de heartbeat
            this.heartbeatHistory = [];
            this.lastHeartbeatTime = Date.now();
            
            // Reconecta
            await this.connect();
            
            this.isReconnecting = false;
            console.info('Reconexão bem-sucedida!');
        } catch (e) {
            this.isReconnecting = false;
            console.error('Falha na reconexão:', e);
            
            // Tenta reconectar novamente após 5 segundos
            setTimeout(() => this.reconnect(), 5000);
        }
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