import AtalaiaAMQP from './AtalaiaAMQP.js';
import AtalaiaRTSPRecorder from './AtalaiaRTSPRecorder.js';
import AtalaiaSingleRecorder from './AtalaiaSingleRecorder.js';
import { DahuaAction, ISmartMotionHuman, IVideoMotion } from './dahua/DahuaEventListener.js';
import { debugLog } from './debug.js';
import { AtalaiaEventAction, IAtalaiaRecorder } from './IAtalaiaRecorder.js';

export interface RecorderManagerConfig {
    username: string;
    password: string;
    dahuaUrl: string;
    atalaiaQueue: AtalaiaAMQP;
    outputDir: string;
    numChannels: number;
    ffmpegPath?: string;
    atalaiaRtspRecorder?: boolean;
}

export default class RecorderManager {
    private readonly recorders = new Map<number, IAtalaiaRecorder>();
    private readonly manualRecorders = new Map<number, AtalaiaRTSPRecorder>();
    private readonly recordingEnabled = new Map<number, boolean>();
    private readonly config: RecorderManagerConfig;
    private readonly resolvedFfmpegPath: string;
    private readonly atalaiaRtspRecorder: boolean;

    constructor(config: RecorderManagerConfig) {
        this.config = config;
        this.resolvedFfmpegPath = config.ffmpegPath ?? process.env.FFMPEG_PATH ?? 'ffmpeg';
        this.atalaiaRtspRecorder = config.atalaiaRtspRecorder ?? false;

        // Por padrão, todos os canais começam desabilitados
        for (let i = 1; i <= config.numChannels; i++) {
            this.recordingEnabled.set(i, false);
        }
    }

    private static toAction(action: DahuaAction): AtalaiaEventAction {
        switch (action) {
            case DahuaAction.START:
                return 'start';

            case DahuaAction.STOP:
                return 'stop';

            default:
                return 'pulse';
        }
    }

    /**
     * Habilita gravações para um canal específico
     */
    public enableChannel(channel: number): void {
        if (channel < 1 || channel > this.config.numChannels) {
            console.error(`Canal ${channel} inválido. Deve estar entre 1 e ${this.config.numChannels}`);
            return;
        }

        debugLog(`[RecorderManager] Habilitando gravações para canal ${channel}`);
        this.recordingEnabled.set(channel, true);

        // Cria o recorder se ainda não existe
        if (!this.recorders.has(channel)) {
            this.createRecorder(channel, 'auto');
        }
    }

    /**
     * Desabilita gravações para um canal específico
     */
    public disableChannel(channel: number): void {
        if (channel < 1 || channel > this.config.numChannels) {
            console.error(`Canal ${channel} inválido. Deve estar entre 1 e ${this.config.numChannels}`);
            return;
        }

        debugLog(`[RecorderManager] Desabilitando gravações para canal ${channel}`);
        this.recordingEnabled.set(channel, false);

        // Remove o recorder existente
        const recorder = this.recorders.get(channel);
        if (recorder) {
            recorder.close();
            this.recorders.delete(channel);
        }
    }

    /**
     * Inicia uma gravação manual para um canal específico
     */
    public startManualRecording(channel: number, durationMs: number = 20000): void {
        if (channel < 1 || channel > this.config.numChannels) {
            console.error(`Canal ${channel} inválido. Deve estar entre 1 e ${this.config.numChannels}`);
            return;
        }

        // Verifica se já há gravação em andamento neste canal
        if (this.isChannelRecording(channel)) {
            console.warn(`[RecorderManager] Canal ${channel} já está gravando, ignorando solicitação de gravação manual`);
            return;
        }

        debugLog(`[RecorderManager] Iniciando gravação manual para canal ${channel} (${durationMs}ms)`);

        // Cria um recorder temporário do tipo 'manual'
        const videoUrl = this.buildRtspUrl(channel);
        const manualRecorder = new AtalaiaRTSPRecorder({
            videoUrl,
            atalaiaQueue: this.config.atalaiaQueue,
            channel,
            outputDir: this.config.outputDir,
            maxRecordingMs: durationMs,
            maxInactivityMs: durationMs, // Para gravação manual, os dois valores são iguais
            ffmpegPath: this.resolvedFfmpegPath,
            recordingType: 'manual'
        });

        // Registra o recorder manual
        this.manualRecorders.set(channel, manualRecorder);

        // Inicia a gravação imediatamente
        manualRecorder.notifyMovement();

        // Remove o recorder manual após a duração + margem de segurança
        setTimeout(() => {
            if (this.manualRecorders.get(channel) === manualRecorder) {
                this.manualRecorders.delete(channel);
                debugLog(`[RecorderManager] Gravação manual do canal ${channel} finalizada`);
            }
        }, durationMs);
    }

    /**
     * Processa evento de movimento de vídeo
     */
    public onVideoMotion(channel: number, action: DahuaAction, event: IVideoMotion): void {
        if (!this.isChannelEnabled(channel)) {
            return;
        }

        const recorderAction = RecorderManager.toAction(action);

        // Se há gravação manual em andamento, ignora eventos automáticos
        const manualRecorder = this.manualRecorders.get(channel);
        if (manualRecorder) {
            debugLog(`[RecorderManager] Ignorando evento de movimento no canal ${channel} (gravação manual em andamento)`);
            manualRecorder.notify({
                kind: 'movement',
                action: recorderAction,
                smart: event.SmartMotionEnable
            });
            return;
        }

        const recorder = this.recorders.get(channel);
        if (recorder) {
            recorder.notify({
                kind: 'movement',
                action: recorderAction,
                smart: event.SmartMotionEnable
            });
        }
    }

    /**
     * Processa evento de detecção de pessoa
     */
    public onPersonDetected(channel: number, action: DahuaAction, event: ISmartMotionHuman): void {
        if (!this.isChannelEnabled(channel)) {
            return;
        }

        const recorderAction = RecorderManager.toAction(action);

        // Se há gravação manual em andamento, notifica o recorder manual
        const manualRecorder = this.manualRecorders.get(channel);
        if (manualRecorder) {
            debugLog(`[RecorderManager] Pessoa detectada no canal ${channel} durante gravação manual`);
            manualRecorder.notify({ kind: 'person', action: recorderAction });
            return;
        }

        const recorder = this.recorders.get(channel);
        if (recorder) {
            debugLog(`[RecorderManager] Pessoa detectada no canal ${channel}`);
            recorder.notify({ kind: 'person', action: recorderAction });
        } else {
            console.warn(`[RecorderManager] Pessoa detectada no canal ${channel}, mas recorder não existe`);
        }
    }

    /**
     * Verifica se um canal está habilitado para gravação
     */
    public isChannelEnabled(channel: number): boolean {
        return this.recordingEnabled.get(channel) ?? false;
    }

    /**
     * Verifica se há gravação em andamento em um canal (manual ou automática)
     */
    private isChannelRecording(channel: number): boolean {
        return this.manualRecorders.has(channel) || this.recorders.has(channel);
    }

    /**
     * Retorna o estado de todos os canais
     */
    public getChannelStates(): Map<number, boolean> {
        return new Map(this.recordingEnabled);
    }

    /**
     * Fecha todos os recorders
     */
    public closeAll(): void {
        debugLog('[RecorderManager] Fechando todos os recorders');
        for (const recorder of this.recorders.values()) {
            recorder.close();
        }
        this.recorders.clear();
        
        for (const recorder of this.manualRecorders.values()) {
            recorder.close();
        }
        this.manualRecorders.clear();
    }

    /**
     * Cria um recorder para um canal específico
     */
    private createRecorder(channel: number, recordingType: 'auto' | 'manual'): void {
        const videoUrl = this.buildRtspUrl(channel);
        
        if (this.atalaiaRtspRecorder && recordingType !== 'manual') {
            this.recorders.set(channel, new AtalaiaSingleRecorder({
                videoUrl,
                atalaiaQueue: this.config.atalaiaQueue,
                channel
            }));
        } else {
            this.recorders.set(channel, new AtalaiaRTSPRecorder({
                videoUrl,
                atalaiaQueue: this.config.atalaiaQueue,
                channel,
                outputDir: this.config.outputDir,
                maxRecordingMs: 30000,
                maxInactivityMs: 5000,
                ffmpegPath: this.resolvedFfmpegPath,
                recordingType
            }));
        }

        debugLog(`[RecorderManager] Recorder criado para canal ${channel}`);
    }

    /**
     * Constrói a URL RTSP para um canal
     */
    private buildRtspUrl(channel: number): string {
        const { username, password, dahuaUrl } = this.config;
        const host = dahuaUrl.replace(/^https?:\/\/([^/]+).*/, '$1');
        return `rtsp://${username}:${password}@${host}:554/cam/realmonitor?channel=${channel}&subtype=1`;
    }
}
