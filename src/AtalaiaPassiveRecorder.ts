import { exec } from 'node:child_process';
import AtalaiaAMQP from './AtalaiaAMQP';
import { unlink } from 'node:fs';
import { IAtalaiaRecorder } from './IAtalaiaRecorder';
import { debugLog } from './debug';

export enum NotifyAs {
    NONE = 'none',
    MOVEMENT = 'movement',
    PERSON = 'person'
}

export interface AtalaiaPassiveRecorderConfig {
    videoUrl: string;
    atalaiaQueue: AtalaiaAMQP;
    channel: number;
    movementNotify?: NotifyAs;
    personNotify?: NotifyAs;
}

export default class AtalaiaPassiveRecorder implements IAtalaiaRecorder {
    private humanDetected = false;
    private smart = false;
    private atalaiaProcess: ReturnType<typeof exec>;
    private readonly atalaiaQueue: AtalaiaAMQP;
    private readonly channel: number;
    private readonly movementNotify: NotifyAs;
    private readonly personNotify: NotifyAs;

    constructor({ videoUrl, atalaiaQueue, channel, movementNotify, personNotify }: AtalaiaPassiveRecorderConfig) {
        this.atalaiaQueue = atalaiaQueue;
        this.channel = channel;
        this.movementNotify = movementNotify ?? NotifyAs.MOVEMENT;
        this.personNotify = personNotify ?? NotifyAs.PERSON;

        const command = `atalaia-streaming movements -p '${videoUrl}'`;

        // Create a process to run the atalaia-streaming command
        this.atalaiaProcess = exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error(`Error executing atalaia-streaming: ${error.message}`);
            } else if (stderr) {
                console.error(`atalaia-streaming stderr: ${stderr}`);
            }

            // process.exit(-1);
        });

        if (this.atalaiaProcess.stdout) {
            this.atalaiaProcess.stdout.on('data', (data: string) => {
                this.handleStdout(data);
            });
        }

        this.atalaiaProcess.stdout?.pipe(process.stdout);
        this.atalaiaProcess.stderr?.pipe(process.stderr);
    }

    close() {
        this.atalaiaProcess.kill('SIGTERM');

        const killTimeout = setTimeout(() => {
            this.atalaiaProcess.kill('SIGKILL');
        }, 30_000);

        process.once('exit', () => {
            clearTimeout(killTimeout);
        });
    }

    notifyMovement(smart = false) {
        // Se está habilitada a detecção, então ignoramos.
        if (smart) {
            return;
        }

        this.smart = smart;
        this.atalaiaProcess.stdin?.write('movement\n');
    }

    notifyPerson() {
        this.humanDetected = true;
        this.smart = true;
        this.atalaiaProcess.stdin?.write('movement\n');
    }

    private handleStdout(data: string) {
        const match = data.match(/^movement\s+(\S+?$)/m);
        const filename = match ? match[1] : null;

        if (filename) {
            debugLog('VideoMotion detected', this.channel, filename, this.humanDetected, this.smart);

            if (this.humanDetected) {
                debugLog(`Human detected on channel ${this.channel}, notifying person:`, filename);
                this.enqueue(this.personNotify, filename);
            } else if (!this.smart) {
                debugLog('Notifying movement:', filename);
                this.enqueue(this.movementNotify, filename);
            } else {
                this.enqueue(NotifyAs.NONE, filename);
            }

            this.clear();
        }
    }

    private enqueue(as: NotifyAs, filename: string) {
        switch (as) {
            case NotifyAs.MOVEMENT:
                this.atalaiaQueue.notifyMovement(filename);
                break;
            
            case NotifyAs.PERSON:
                this.atalaiaQueue.notifyPerson(filename);
                break;
            
            default:
                unlink(filename + '.mp4', function () { });
                unlink(filename + '.movements', function () { });
                break;
        }
    }

    private clear() {
        this.humanDetected = false;
        this.smart = false;
    }
}