import AtalaiaAMQP from './AtalaiaAMQP.js';
import { IAtalaiaEvent, IAtalaiaRecorder } from './IAtalaiaRecorder.js';
import DahuaRTSPStream from './dahua/DahuaRTSPStream.js';
import DahuaRTSPRecorder from './dahua/DahuaRTSPRecorder.js';
import { debugLog } from './debug.js';

export interface AtalaiaRTSPRecorderConfig {
    videoUrl: string;
    atalaiaQueue: AtalaiaAMQP;
    channel: number;
    outputDir: string;
    maxRecordingMs?: number;
    maxInactivityMs?: number;
    ffmpegPath?: string;
    recordingType?: 'auto' | 'manual';
}

export default class AtalaiaRTSPRecorder implements IAtalaiaRecorder {
    private recording: DahuaRTSPRecorder | null = null;
    private hasPerson = false;
    private readonly activeTriggers = new Set<'movement' | 'person'>();
    private maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
    private inactivityTimer: ReturnType<typeof setTimeout> | null = null;
    private finalizing = false;
    private readonly stream: DahuaRTSPStream;
    private readonly atalaiaQueue: AtalaiaAMQP;
    private readonly channel: number;
    private readonly outputDir: string;
    private readonly maxRecordingMs: number;
    private readonly maxInactivityMs: number;
    private readonly ffmpegPath: string;
    private readonly recordingType: 'auto' | 'manual';

    constructor({
        videoUrl,
        atalaiaQueue,
        channel,
        outputDir,
        maxRecordingMs,
        maxInactivityMs,
        ffmpegPath,
        recordingType
    }: AtalaiaRTSPRecorderConfig) {
        this.stream = new DahuaRTSPStream(videoUrl);
        this.atalaiaQueue = atalaiaQueue;
        this.channel = channel;
        this.outputDir = outputDir;
        this.maxRecordingMs = maxRecordingMs ?? 30_000;
        this.maxInactivityMs = maxInactivityMs ?? 5_000;
        this.ffmpegPath = ffmpegPath ?? process.env.FFMPEG_PATH ?? 'ffmpeg';
        this.recordingType = recordingType ?? 'auto';
    }

    public notify(event: IAtalaiaEvent): void {
        if (event.kind === 'person' && event.action !== 'stop') {
            this.hasPerson = true;
        }

        if (event.kind === 'movement' && event.smart && event.action !== 'stop' && !this.hasPerson) {
            return;
        }

        const inactivityMs = event.postStopMs ?? this.maxInactivityMs;

        switch (event.action) {
            case 'start':
                this.activeTriggers.add(event.kind);
                this.onActivity(inactivityMs);
                break;

            case 'stop':
                this.activeTriggers.delete(event.kind);
                if (this.activeTriggers.size === 0 && this.recording) {
                    this.scheduleInactivityStop(inactivityMs);
                }
                break;

            default:
                this.onActivity(inactivityMs);
                break;
        }
    }

    public notifyMovement(smart: boolean = false): void {
        this.notify({ kind: 'movement', action: 'pulse', smart });
    }

    public notifyPerson(): void {
        this.notify({ kind: 'person', action: 'pulse' });
    }

    public close(): void {
        this.clearTimers();
        const current = this.recording;
        this.recording = null;
        this.hasPerson = false;
        this.activeTriggers.clear();

        if (!current) {
            return;
        }

        current.discard().catch((error: unknown) => {
            console.error('Erro ao descartar gravação RTSP no fechamento:', error);
        });
    }

    private onActivity(inactivityMs = this.maxInactivityMs): void {
        if (!this.recording) {
            this.startRecording().catch((error: unknown) => {
                console.error('Erro ao iniciar gravação RTSP:', error);
            });
            return;
        }

        this.scheduleInactivityStop(inactivityMs);
    }

    private async startRecording(): Promise<void> {
        if (this.recording || this.finalizing) {
            return;
        }

        const recording = new DahuaRTSPRecorder({
            stream: this.stream,
            channel: this.channel,
            outputDir: this.outputDir,
            ffmpegPath: this.ffmpegPath
        });

        recording.start();

        this.recording = recording;

        this.maxDurationTimer = setTimeout(() => {
            this.finalizeRecording('max-duration').catch((error: unknown) => {
                console.error('Erro ao finalizar por duração máxima:', error);
            });
        }, this.maxRecordingMs);

        this.scheduleInactivityStop(this.maxInactivityMs);
    }

    private scheduleInactivityStop(inactivityMs: number): void {
        if (this.inactivityTimer) {
            clearTimeout(this.inactivityTimer);
        }

        this.inactivityTimer = setTimeout(() => {
            this.finalizeRecording('inactivity').catch((error: unknown) => {
                console.error('Erro ao finalizar por inatividade:', error);
            });
        }, inactivityMs);
    }

    private clearTimers(): void {
        if (this.maxDurationTimer) {
            clearTimeout(this.maxDurationTimer);
            this.maxDurationTimer = null;
        }

        if (this.inactivityTimer) {
            clearTimeout(this.inactivityTimer);
            this.inactivityTimer = null;
        }
    }

    private async finalizeRecording(reason: 'max-duration' | 'inactivity'): Promise<void> {
        if (this.finalizing) {
            return;
        }

        const current = this.recording;

        if (!current) {
            return;
        }

        this.finalizing = true;
        this.recording = null;
        this.clearTimers();

        try {
            await current.stop();
            const outputPath = current.getOutputPath();

            if (outputPath) {
                if (this.recordingType === 'manual') {
                    if (this.hasPerson) {
                        debugLog('Gravação manual com pessoa detectada', this.channel, reason, outputPath);
                        this.atalaiaQueue.notifyPerson(outputPath);
                    } else {
                        debugLog('Gravação manual sem pessoa detectada', this.channel, reason, outputPath);
                        this.atalaiaQueue.notifyManual(outputPath);
                    }
                } else {
                    // Gravação automática: só notifica se houver pessoa
                    if (this.hasPerson) {
                        debugLog('Gravação RTSP com pessoa detectada', this.channel, reason, outputPath);
                        this.atalaiaQueue.notifyPerson(outputPath);
                    } else {
                        debugLog('Descartando gravação RTSP sem pessoa', this.channel, reason, outputPath);
                        await current.discard();
                    }
                }
            }
        } finally {
            this.hasPerson = false;
            this.activeTriggers.clear();
            this.finalizing = false;
        }
    }
}