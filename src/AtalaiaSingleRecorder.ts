import { ChildProcess, exec } from 'node:child_process';
import AtalaiaAMQP from './AtalaiaAMQP';
import { IAtalaiaRecorder } from './IAtalaiaRecorder';
import { debugLog } from './debug';

interface IRecordingData {
    process: ChildProcess;
    smart: boolean;
}

export default class AtalaiaSingleRecorder implements IAtalaiaRecorder {
    private movementRecording: IRecordingData | null = null;
    private humanDetected = false;
    private readonly videoUrl: string;
    private readonly atalaiaQueue: AtalaiaAMQP;
    private readonly channel: number;

    constructor({ videoUrl, atalaiaQueue, channel }: {
        videoUrl: string;
        atalaiaQueue: AtalaiaAMQP;
        channel: number;
    }) {
        this.videoUrl = videoUrl;
        this.atalaiaQueue = atalaiaQueue;
        this.channel = channel;
    }

    notifyMovement(smart?: boolean): void {
        this.record(smart ?? false).catch(() => {})
    }

    notifyPerson(): void {
        const channel = this.channel;
        debugLog('Person detected on channel', channel);
        this.humanDetected = true;
    }
 
    private record(smart: boolean): Promise<string> {
        if (this.movementRecording) {
            return Promise.reject();
        }

        const now = new Date().getHours();

        if (this.channel > 4 && (now < 22 || now >= 7)) {
            debugLog('Ignoring movement on channel', this.channel, 'time', now);
            this.humanDetected = false;
            return Promise.reject();
        }

        debugLog('Recording video', this.channel);

        return new Promise((resolve, reject) => {
            const p = exec(`atalaia-streaming movements -s '${this.videoUrl}'`, { encoding: 'utf-8' }, (error, stdout, stderr) => {
                if (!error) {
                    const match = stdout.match(/^movement\s+(\S+?$)/m);
                    const filename = match ? match[1] : null;
                    debugLog('VideoMotion detected', this.channel, filename);

                    if (filename) {
                        if (this.humanDetected) {
                            debugLog(`Human detected on channel ${this.channel}, notifying person:`, filename);
                            this.atalaiaQueue.notifyPerson(filename);
                            this.humanDetected = false;
                        } else if (!smart) {
                            debugLog('Notifying movement:', filename);
                            this.atalaiaQueue.notifyMovement(filename);
                        }

                        resolve(filename);
                    } else {
                        reject(new Error(stdout));
                    }
                } else {
                    console.error('Error recording video:', error);
                    reject(new Error(stderr));
                }

                this.movementRecording = null;
            });

            if (p.stdout) p.stdout.pipe(process.stdout);
            // if (p.stderr) p.stderr.pipe(process.stderr);

            this.movementRecording = { process: p, smart };
        });
    }

    close(): void {
        if (this.movementRecording) {
            const process = this.movementRecording.process;
            process.kill('SIGTERM');
            
            // Se não encerrar em 30 segundos, envia SIGKILL
            const killTimeout = setTimeout(() => {
                console.warn(`Process ${process.pid} did not terminate, sending SIGKILL`);
                process.kill('SIGKILL');
            }, 30_000);
            
            // Limpa o timeout quando o processo encerrar
            process.once('exit', () => {
                clearTimeout(killTimeout);
            });
            
            this.movementRecording = null;
        }
        this.humanDetected = false;
    }
}