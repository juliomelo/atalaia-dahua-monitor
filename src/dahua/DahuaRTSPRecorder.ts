import { ChildProcessByStdio, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import DahuaRTSPStream from './DahuaRTSPStream.js';
import Stream from 'node:stream';

export interface DahuaRTSPRecorderConfig {
    stream: DahuaRTSPStream;
    channel: number;
    outputDir: string;
    ffmpegPath?: string;
}

export default class DahuaRTSPRecorder {
    private readonly stream: DahuaRTSPStream;
    private readonly channel: number;
    private readonly outputDir: string;
    private readonly ffmpegPath: string;
    private outputPath: string | null = null;
    private process: ChildProcessByStdio<null, Stream.Readable, Stream.Readable> | null = null;
    private isRecording: boolean = false;

    constructor({ stream, channel, outputDir, ffmpegPath }: DahuaRTSPRecorderConfig) {
        this.stream = stream;
        this.channel = channel;
        this.outputDir = outputDir;
        this.ffmpegPath = ffmpegPath ?? process.env.FFMPEG_PATH ?? 'ffmpeg';
    }

    public start(): void {
        if (this.process || this.isRecording) {
            throw new Error('Recording already started.');
        }

        const now = Date.now();
        this.outputPath = join(this.outputDir, `atalaia-ch${this.channel}-${now}.mp4`);

        const args = [
            '-hide_banner',
            '-loglevel', 'error',
            ...this.stream.getFFmpegInputArgs(),
            '-map', '0',
            '-c', 'copy',
            '-y',
            this.outputPath
        ];

        const ffmpeg = spawn('/usr/bin/env', [this.ffmpegPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });

        ffmpeg.stdout.pipe(process.stdout);
        ffmpeg.stderr.pipe(process.stderr);

        this.process = ffmpeg;
        this.isRecording = true;
    }

    public async stop(graceMs = 3_000): Promise<void> {
        if (!this.process || !this.isRecording) {
            throw new Error('Recording is not running.');
        }

        const proc = this.process;

        await new Promise<void>((resolve) => {
            let done = false;
            const finish = () => {
                if (done) {
                    return;
                }

                done = true;
                resolve();
            };

            const timeout = setTimeout(() => {
                proc.kill('SIGKILL');
            }, graceMs);

            proc.once('exit', () => {
                clearTimeout(timeout);
                finish();
            });

            proc.kill('SIGINT');
        });

        this.process = null;
        this.isRecording = false;
    }

    public async discard(): Promise<void> {
        if (this.process || this.isRecording) {
            await this.stop();
        }

        if (this.outputPath) {
            await unlink(this.outputPath).catch(() => undefined);
        }
    }

    public getOutputPath(): string | null {
        return this.outputPath;
    }

    public isRunning(): boolean {
        return this.isRecording;
    }
}