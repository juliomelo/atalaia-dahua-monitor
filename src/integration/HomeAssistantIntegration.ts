import mqtt from 'mqtt';
import DahuaConnection from '../dahua/DahuaConnection.js';
import DahuaSystem from '../dahua/DahuaSystem.js';
import DahuaVideo from '../dahua/DahuaVideo.js';
import DahuaConfigManager from '../dahua/DahuaConfigManager.js';
import DahuaEventListener, { DahuaAction, ISmartMotionHuman, IVideoMotion } from '../dahua/DahuaEventListener.js';
import RecorderManager from '../RecorderManager.js';
import { debugLog } from '../debug.js';

interface DeviceInfo {
    ids: string[];
    name: string;
    mf: string;
    mdl: string;
    sn: string;
    hw: string;
}

export default class HomeAssistantIntegration {
    private client: mqtt.MqttClient | null = null;
    private deviceInfo: DeviceInfo | null = null;
    private serialNumber: string = '';
    private readonly recordingEnabled = new Map<number, boolean>();
    private readonly pulseTimeout = 5_000;
    private recorderManager: RecorderManager | null = null;
    private numChannels: number = 0;
    private channelTitles: string[] | null = null;
    
    constructor(
        private readonly url: string,
        dahua: DahuaConnection,
        eventListener: DahuaEventListener,
        recorderManager: RecorderManager,
        private readonly homeAssistantTopic = 'homeassistant'
    ) {
        this.recorderManager = recorderManager;
        this.setup(new DahuaSystem(dahua), new DahuaVideo(dahua), new DahuaConfigManager(dahua));
        eventListener.addEventListener('VideoMotion', this.onVideoMotion.bind(this));
        eventListener.addEventListener('SmartMotionHuman', this.onPersonDetected.bind(this));
    }

    private async onVideoMotion(action: DahuaAction, index: number, event: IVideoMotion): Promise<void> {
        const channel = index + 1;
        
        switch (action) {
            case DahuaAction.START:
                await this.updateMotion(channel, true);
                break;
            case DahuaAction.STOP:
                await this.updateMotion(channel, false);
                break;
            case DahuaAction.PULSE:
                await this.updateMotion(channel, true);
                setTimeout(() => {
                    this.updateMotion(channel, false).catch(e => {
                        console.error('Error resetting motion sensor after pulse for channel', channel, e);
                    });
                }, this.pulseTimeout);
                break;
        }
    }

    private async onPersonDetected(action: DahuaAction, index: number, event: ISmartMotionHuman): Promise<void> {
        const channel = index + 1;
        
        switch (action) {
            case DahuaAction.START:
                await this.updatePerson(channel, true);
                break;
            case DahuaAction.STOP:
                await this.updatePerson(channel, false);
                break;
            case DahuaAction.PULSE:
                await this.updatePerson(channel, true);
                setTimeout(() => {
                    this.updatePerson(channel, false).catch(e => {
                        console.error('Error resetting person sensor after pulse for channel', channel, e);
                    });
                }, this.pulseTimeout);
                break;
        }
    }

    private async setup(dahua: DahuaSystem, video: DahuaVideo, config: DahuaConfigManager): Promise<void> {
        try {
            this.serialNumber = (await dahua.getSerialNumber()).replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/, '');
            
            this.deviceInfo = {
                ids: [this.serialNumber],
                name: await dahua.getDeviceType(),
                mf: await dahua.getVendor(),
                mdl: await dahua.getDeviceType(),
                sn: this.serialNumber,
                hw: await dahua.getHardwareVersion()
            };

            await this.connect();
            
            this.numChannels = await video.getChannels();
            this.channelTitles = await (config.getChannelTitle().catch(e => {
                console.warn('Could not get channel titles:', e);
                return null;
            }));
            
            await this.registerSensors(this.numChannels, this.channelTitles);
            await this.setRecorderManager();
        } catch (error) {
            console.error('[HA] Erro durante setup:', error);
        }
    }

    private async connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            // Remove caracteres inválidos do serial number para o clientId
            const clientId = `homeassistant-atalaia-${this.serialNumber}`;
            console.log('[MQTT] Client ID:', clientId);

            this.client = mqtt.connect(this.url, {
                clientId: clientId,
                clean: true,
                connectTimeout: 4000,
                reconnectPeriod: 1000,
                protocolVersion: 4
            });

            this.client.on('connect', () => {
                resolve();
            });

            this.client.on('error', (error) => {
                reject(error);
            });
        });
    }

    private async registerSensors(numChannels: number, channelTitles: string[] | null): Promise<void> {
        if (!this.client || !this.deviceInfo) {
            throw new Error('MQTT client or device information not initialized');
        }

        console.info('Registering channels', channelTitles);

        for (let ch = 0; ch < numChannels; ch++) {
            for (const sensorType of ['Motion', 'Person']) {
                const uniqueId = `${sensorType.toLocaleLowerCase()}_${this.serialNumber}_ch${ch}`;
                const sensorConfig = {
                    device: this.deviceInfo,
                    availability_topic: `${this.homeAssistantTopic}/device/atalaiaDahua/${this.serialNumber}/availability`,
                    device_class: 'motion',
                    name: `${channelTitles && channelTitles[ch] ? channelTitles[ch] : `Channel ${ch + 1}`} - ${sensorType}`,
                    payload_off: 'false',
                    payload_on: 'true',
                    state_topic: `${this.homeAssistantTopic}/device/atalaiaDahua/${this.serialNumber}/ch${ch}/${sensorType.toLowerCase()}`,
                    unique_id: uniqueId,
                    value_template: '{{ value }}',
                    origin: {
                        name: 'Atalaia Dahua',
                        sw: '1.0'
                    }
                };

                const configTopic = `${this.homeAssistantTopic}/binary_sensor/${uniqueId}/config`;
                
                await new Promise<void>((resolve, reject) => {
                    this.client!.publish(configTopic, JSON.stringify(sensorConfig), { retain: true }, (err) => {
                        if (err) {
                            console.error(`Error registering sensor for channel ${ch}:`, err);
                            reject(err);
                        } else {
                            console.log(`${sensorType} sensor for channel ${ch} registered successfully`);
                            resolve();
                        }
                    });
                });
            }
        }

        // Publish availability as online after registering sensors
        await this.updateAvailability(true);
    }

    /**
     * Updates the state of the motion sensor for a specific channel
     * 
     * @param channel - Channel number
     * @param hasMotion - true if there is motion, false otherwise
     */
    async updateMotion(channel: number, hasMotion: boolean): Promise<void> {
        if (!this.client) {
            throw new Error('MQTT client not initialized');
        }

        const stateTopic = `${this.homeAssistantTopic}/device/atalaiaDahua/${this.serialNumber}/ch${channel}/motion`;
        const payload = hasMotion ? 'true' : 'false';

        return new Promise((resolve, reject) => {
            this.client!.publish(stateTopic, payload, { retain: false }, (err) => {
                if (err) {
                    console.error(`Error updating motion for channel ${channel}:`, err);
                    reject(err);
                } else {
                    debugLog(`Motion for channel ${channel} updated to: ${payload}`);
                    resolve();
                }
            });
        });
    }

    /**
     * Updates the state of the motion sensor for a specific channel
     * 
     * @param channel - Channel number
     * @param hasPerson - true if there is a person, false otherwise
     */
    async updatePerson(channel: number, hasPerson: boolean): Promise<void> {
        if (!this.client) {
            throw new Error('MQTT client not initialized');
        }

        const stateTopic = `${this.homeAssistantTopic}/device/atalaiaDahua/${this.serialNumber}/ch${channel}/person`;
        const payload = hasPerson ? 'true' : 'false';

        return new Promise((resolve, reject) => {
            this.client!.publish(stateTopic, payload, { retain: false }, (err) => {
                if (err) {
                    console.error(`Error updating person for channel ${channel}:`, err);
                    reject(err);
                } else {
                    debugLog(`Person for channel ${channel} updated to: ${payload}`);
                    resolve();
                }
            });
        });
    }

    /**
     * Updates the availability of the device
     * 
     * @param available - true if available, false otherwise
     */
    public async updateAvailability(available: boolean): Promise<void> {
        if (!this.client) {
            throw new Error('MQTT client not initialized');
        }

        const availabilityTopic = `${this.homeAssistantTopic}/device/atalaiaDahua/${this.serialNumber}/availability`;
        const payload = available ? 'online' : 'offline';

        return new Promise((resolve, reject) => {
            this.client!.publish(availabilityTopic, payload, { retain: true }, (err) => {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    /**
     * Registra switches e botões no Home Assistant após numChannels estar definido
     */
    private async setRecorderManager(): Promise<void> {
        if (this.numChannels > 0) {
            await this.registerRecordingSwitches();
            await this.registerManualRecordingButtons();
            await this.syncSwitchStates();
        }
    }

    /**
     * Registra switches de gravação para cada canal no Home Assistant
     */
    private async registerRecordingSwitches(): Promise<void> {
        if (!this.client || !this.deviceInfo) {
            throw new Error('MQTT client or device information not initialized');
        }

        debugLog('[HA] Registrando switches de gravação para canais');

        for (let ch = 0; ch < this.numChannels; ch++) {
            const channel = ch + 1;
            const uniqueId = `recording_${this.serialNumber}_ch${ch}`;
            const channelName = this.channelTitles && this.channelTitles[ch] 
                ? this.channelTitles[ch] 
                : `Channel ${channel}`;

            const switchConfig = {
                device: this.deviceInfo,
                availability_topic: `${this.homeAssistantTopic}/device/atalaiaDahua/${this.serialNumber}/availability`,
                name: `${channelName} - Recording`,
                state_topic: `${this.homeAssistantTopic}/device/atalaiaDahua/${this.serialNumber}/ch${ch}/recording/state`,
                command_topic: `${this.homeAssistantTopic}/device/atalaiaDahua/${this.serialNumber}/ch${ch}/recording/set`,
                payload_on: 'ON',
                payload_off: 'OFF',
                state_on: 'ON',
                state_off: 'OFF',
                unique_id: uniqueId,
                icon: 'mdi:record-rec',
                optimistic: false,
                retain: true,
                origin: {
                    name: 'Atalaia Dahua',
                    sw: '1.0'
                }
            };

            const configTopic = `${this.homeAssistantTopic}/switch/${uniqueId}/config`;
            
            await new Promise<void>((resolve, reject) => {
                this.client!.publish(configTopic, JSON.stringify(switchConfig), { retain: true }, (err) => {
                    if (err) {
                        console.error(`[HA] Erro ao registrar switch de gravação para canal ${channel}:`, err);
                        reject(err);
                    } else {
                        debugLog(`[HA] Switch de gravação para canal ${channel} registrado com sucesso`);
                        resolve();
                    }
                });
            });

            // Subscreve ao command topic
            const commandTopic = `${this.homeAssistantTopic}/device/atalaiaDahua/${this.serialNumber}/ch${ch}/recording/set`;
            this.client.subscribe(commandTopic, (err) => {
                if (err) {
                    console.error(`[HA] Erro ao subscrever command topic para canal ${channel}:`, err);
                }
            });
        }

        // Configura handler para mensagens recebidas
        this.client.on('message', (topic, message) => {
            this.handleMqttMessage(topic, message);
        });
    }

    /**
     * Registra botões de gravação manual para cada canal no Home Assistant
     */
    private async registerManualRecordingButtons(): Promise<void> {
        if (!this.client || !this.deviceInfo) {
            throw new Error('MQTT client or device information not initialized');
        }

        console.info('[HA] Registrando botões de gravação manual para canais');

        for (let ch = 0; ch < this.numChannels; ch++) {
            const channel = ch + 1;
            const uniqueId = `manual_rec_${this.serialNumber}_ch${ch}`;
            const channelName = this.channelTitles && this.channelTitles[ch] 
                ? this.channelTitles[ch] 
                : `Channel ${channel}`;

            const buttonConfig = {
                device: this.deviceInfo,
                availability_topic: `${this.homeAssistantTopic}/device/atalaiaDahua/${this.serialNumber}/availability`,
                name: `${channelName} - Manual Recording`,
                command_topic: `${this.homeAssistantTopic}/device/atalaiaDahua/${this.serialNumber}/ch${ch}/manual_rec/press`,
                payload_press: 'PRESS',
                unique_id: uniqueId,
                icon: 'mdi:record-circle',
                origin: {
                    name: 'Atalaia Dahua',
                    sw: '1.0'
                }
            };

            const configTopic = `${this.homeAssistantTopic}/button/${uniqueId}/config`;
            
            await new Promise<void>((resolve, reject) => {
                this.client!.publish(configTopic, JSON.stringify(buttonConfig), { retain: true }, (err) => {
                    if (err) {
                        console.error(`[HA] Erro ao registrar botão manual para canal ${channel}:`, err);
                        reject(err);
                    } else {
                        console.log(`[HA] Botão de gravação manual para canal ${channel} registrado com sucesso`);
                        resolve();
                    }
                });
            });

            // Subscreve ao command topic
            const commandTopic = `${this.homeAssistantTopic}/device/atalaiaDahua/${this.serialNumber}/ch${ch}/manual_rec/press`;
            this.client.subscribe(commandTopic, (err) => {
                if (err) {
                    console.error(`[HA] Erro ao subscrever command topic do botão para canal ${channel}:`, err);
                }
            });
        }
    }

    /**
     * Sincroniza estados iniciais dos switches a partir das mensagens retained do MQTT
     */
    private async syncSwitchStates(): Promise<void> {
        if (!this.client) {
            throw new Error('MQTT client not initialized');
        }

        console.info('[HA] Sincronizando estados iniciais dos switches...');

        const statePromises: Promise<void>[] = [];

        for (let ch = 0; ch < this.numChannels; ch++) {
            const channel = ch + 1;
            const stateTopic = `${this.homeAssistantTopic}/device/atalaiaDahua/${this.serialNumber}/ch${ch}/recording/state`;
            
            const promise = new Promise<void>((resolve) => {
                const timeout = setTimeout(() => {
                    // Timeout: assume estado inicial como OFF
                    console.info(`[HA] Timeout ao aguardar estado do canal ${channel}, assumindo OFF`);
                    this.recordingEnabled.set(channel, false);
                    resolve();
                }, 3000);

                const handler = (topic: string, message: Buffer) => {
                    if (topic === stateTopic) {
                        const state = message.toString();
                        const enabled = state === 'ON';
                        console.info(`[HA] Estado inicial do canal ${channel}: ${state}`);
                        this.recordingEnabled.set(channel, enabled);
                        
                        if (this.recorderManager) {
                            if (enabled) {
                                this.recorderManager.enableChannel(channel);
                            } else {
                                this.recorderManager.disableChannel(channel);
                            }
                        }
                        
                        clearTimeout(timeout);
                        this.client!.off('message', handler);
                        resolve();
                    }
                };

                this.client!.on('message', handler);
                this.client!.subscribe(stateTopic);
            });

            statePromises.push(promise);
        }

        await Promise.all(statePromises);
        console.info('[HA] Sincronização de estados concluída');
    }

    /**
     * Processa mensagens MQTT recebidas
     */
    private handleMqttMessage(topic: string, message: Buffer): void {
        // Processa comandos de switches de gravação
        const switchMatch = topic.match(/ch(\d+)\/recording\/set$/);
        if (switchMatch) {
            const ch = parseInt(switchMatch[1]);
            const channel = ch + 1;
            const command = message.toString();
            
            console.info(`[HA] Comando de switch recebido para canal ${channel}: ${command}`);
            
            const enabled = command === 'ON';
            this.recordingEnabled.set(channel, enabled);
            
            // Atualiza o RecorderManager
            if (this.recorderManager) {
                if (enabled) {
                    this.recorderManager.enableChannel(channel);
                } else {
                    this.recorderManager.disableChannel(channel);
                }
            }
            
            // Publica o estado atualizado
            const stateTopic = topic.replace('/set', '/state');
            this.client!.publish(stateTopic, command, { retain: true }, (err) => {
                if (err) {
                    console.error(`[HA] Erro ao publicar estado do switch para canal ${channel}:`, err);
                }
            });
            
            return;
        }

        // Processa comandos de botões de gravação manual
        const buttonMatch = topic.match(/ch(\d+)\/manual_rec\/press$/);
        if (buttonMatch) {
            const ch = parseInt(buttonMatch[1]);
            const channel = ch + 1;
            const payload = message.toString();
            
            console.info(`[HA] Comando de gravação manual recebido para canal ${channel}`);
            
            // Tenta fazer parse do payload como JSON para obter duração
            let duration = 20000; // Padrão: 20 segundos
            try {
                if (payload && payload !== 'PRESS') {
                    const parsed = JSON.parse(payload);
                    if (parsed.duration && typeof parsed.duration === 'number') {
                        duration = parsed.duration;
                    }
                }
            } catch (e) {
                // Payload não é JSON ou é o padrão 'PRESS', usa duração padrão
            }
            
            // Inicia gravação manual via RecorderManager
            if (this.recorderManager) {
                this.recorderManager.startManualRecording(channel, duration);
            } else {
                console.warn(`[HA] RecorderManager não configurado, não é possível iniciar gravação manual`);
            }
            
            return;
        }
    }

    /**
     * Disconnects from the MQTT broker
     */
    async disconnect(): Promise<void> {
        if (this.client) {
            await this.updateAvailability(false);
            return new Promise((resolve) => {
                this.client!.end(true, () => resolve());
            });
        }
    }
}