import { ChildProcess, exec } from 'node:child_process';
import AtalaiaAMQP from './AtalaiaAMQP';
import { IAtalaiaEvent, IAtalaiaRecorder } from './IAtalaiaRecorder';
import { debugLog } from './debug';

interface IRecordingData {
    process: ChildProcess;
    movementDetected: boolean;
    personDetected: boolean;
    buffer: string;
}

export default class AtalaiaSingleRecorder implements IAtalaiaRecorder {
    private movementRecording: IRecordingData | null = null;
    private humanDetected = false;
    private readonly videoUrl: string;
    private readonly atalaiaQueue: AtalaiaAMQP;
    private readonly channel: number;
    private readonly maxTotalMs: number;
    private readonly postStopMs: number;

    constructor({ videoUrl, atalaiaQueue, channel, maxTotalMs, postStopMs }: {
        videoUrl: string;
        atalaiaQueue: AtalaiaAMQP;
        channel: number;
        maxTotalMs?: number;
        postStopMs?: number;
    }) {
        this.videoUrl = videoUrl;
        this.atalaiaQueue = atalaiaQueue;
        this.channel = channel;
        this.maxTotalMs = maxTotalMs ?? 10_000;
        this.postStopMs = postStopMs ?? 5_000;
    }

    notifyMovement(smart?: boolean): void {
        this.notify({ kind: 'movement', action: 'pulse', smart: smart ?? false });
    }

    notifyPerson(): void {
        this.notify({ kind: 'person', action: 'pulse' });
    }

    notify(event: IAtalaiaEvent): void {
        const now = new Date().getHours();

        if (this.channel > 4 && (now < 22 || now >= 7)) {
            debugLog('Ignoring event on channel', this.channel, 'time', now, event.kind, event.action);
            this.humanDetected = false;
            return;
        }

        if (event.kind === 'movement' && event.smart && event.action !== 'stop' && !this.humanDetected) {
            return;
        }

        const recording = this.ensureProcess();
        if (!recording) {
            return;
        }

        if (event.kind === 'person' && event.action !== 'stop') {
            recording.personDetected = true;
            this.humanDetected = true;
        }

        if (event.kind === 'movement' && !event.smart && event.action !== 'stop') {
            recording.movementDetected = true;
        }

        recording.process.stdin?.write(`${event.kind} ${event.action}\n`);
    }
 
    private ensureProcess(): IRecordingData | null {
        if (this.movementRecording) {
            return this.movementRecording;
        }

        debugLog('Recording video', this.channel);

        const maxTotalSeconds = Math.max(1, Math.ceil(this.maxTotalMs / 1000));
        const postStopSeconds = Math.max(1, Math.ceil(this.postStopMs / 1000));
        const p = exec(`atalaia-streaming movements -s '${this.videoUrl}' --max-seconds ${maxTotalSeconds} --post-stop-seconds ${postStopSeconds}`, { encoding: 'utf-8' }, (error, _stdout, stderr) => {
            if (error) {
                console.error('Error recording video:', error);
                if (stderr) {
                    console.error(stderr);
                }
            }

            this.movementRecording = null;
            this.humanDetected = false;
        });

        const movementRecording: IRecordingData = {
            process: p,
            movementDetected: false,
            personDetected: false,
            buffer: ''
        };

        if (p.stdout) {
            p.stdout.on('data', (data: string | Buffer) => {
                this.handleStdout(movementRecording, data.toString());
            });
            p.stdout.pipe(process.stdout);
        }

        this.movementRecording = movementRecording;
        return movementRecording;
    }

    private handleStdout(recording: IRecordingData, chunk: string): void {
        recording.buffer += chunk;

        let newline = recording.buffer.indexOf('\n');

        while (newline >= 0) {
            const line = recording.buffer.slice(0, newline).trim();
            recording.buffer = recording.buffer.slice(newline + 1);

            const match = /^movement\s+(\S+)$/.exec(line);
            const filename = match ? match[1] : null;

            if (filename) {
                debugLog('VideoMotion detected', this.channel, filename);

                if (recording.personDetected || this.humanDetected) {
                    debugLog(`Human detected on channel ${this.channel}, notifying person:`, filename);
                    this.atalaiaQueue.notifyPerson(filename);
                } else if (recording.movementDetected) {
                    debugLog('Notifying movement:', filename);
                    this.atalaiaQueue.notifyMovement(filename);
                }

                recording.personDetected = false;
                recording.movementDetected = false;
                this.humanDetected = false;
            }

            newline = recording.buffer.indexOf('\n');
        }
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