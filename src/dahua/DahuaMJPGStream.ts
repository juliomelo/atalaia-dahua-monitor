import { EventEmitter } from 'events';
import DahuaConnection from './DahuaConnection.js';

export interface IJPEGFrame {
    data: Buffer;
    timestamp: number;
}

export default class DahuaMJPGStream extends EventEmitter {
    private abortController: AbortController | null = null;
    private isConnected: boolean = false;

    constructor(
        private readonly connection: DahuaConnection,
        private readonly channel: number,
        private readonly subtype: number = 0
    ) {
        super();
    }

    /**
     * Inicia o stream MJPEG
     */
    public async start(): Promise<void> {
        if (this.isConnected) {
            throw new Error('Stream já está conectado');
        }

        this.abortController = new AbortController();

        try {
            const response = await this.connection.get('/cgi-bin/mjpg/video.cgi', {
                channel: this.channel.toString(),
                subtype: this.subtype.toString()
            }, this.abortController.signal);

            if (!response.ok) {
                throw new Error(`Falha ao conectar ao stream: ${response.status}`);
            }

            this.isConnected = true;
            this.emit('connected');

            // Processa o stream multipart
            await this.processMultipartStream(response);

        } catch (error) {
            this.isConnected = false;
            this.emit('error', error);
            throw error;
        }
    }

    /**
     * Para o stream MJPEG
     */
    public stop(): void {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
        this.isConnected = false;
        this.emit('disconnected');
    }

    /**
     * Retorna se o stream está conectado
     */
    public getIsConnected(): boolean {
        return this.isConnected;
    }

    /**
     * Processa o stream multipart/x-mixed-replace
     */
    private async processMultipartStream(response: Response): Promise<void> {
        const reader = response.body?.getReader();
        if (!reader) {
            throw new Error('Response body não disponível');
        }

        let buffer = Buffer.alloc(0);
        let boundary: string | null = null;

        try {
            while (true) {
                if (this.abortController?.signal.aborted) {
                    break;
                }

                const { done, value } = await reader.read();

                if (done) {
                    this.isConnected = false;
                    this.emit('disconnected');
                    break;
                }

                // Adiciona novo chunk ao buffer
                buffer = Buffer.concat([buffer, Buffer.from(value)]);

                // Extrai o boundary da primeira resposta
                if (boundary === null) {
                    boundary = this.extractBoundary(buffer);
                    if (!boundary) {
                        continue; // Aguarda mais dados para extrair boundary
                    }
                }

                // Processa frames completos no buffer
                buffer = Buffer.from(this.processBuffer(buffer, boundary));
            }
        } finally {
            reader.releaseLock();
        }
    }

    /**
     * Extrai o boundary do header da resposta multipart
     */
    private extractBoundary(buffer: Buffer): string | null {
        const text = buffer.toString('binary', 0, Math.min(buffer.length, 1024));
        const match = text.match(/boundary=([^\r\n]+)/);
        return match ? match[1].trim() : null;
    }

    /**
     * Processa o buffer procurando por frames JPEG completos
     */
    private processBuffer(buffer: Buffer, boundary: string): Buffer {
        const boundaryBuffer = Buffer.from(`--${boundary}`, 'binary');
        const headerEndMarker = Buffer.from('\r\n\r\n', 'binary');

        let position = 0;
        let processedBytes = 0;

        while (position < buffer.length) {
            // Procura pelo próximo boundary
            const boundaryIndex = buffer.indexOf(boundaryBuffer, position);

            if (boundaryIndex === -1) {
                // Não há mais frames completos
                break;
            }

            // Procura pelo header end marker após o boundary
            const headerStart = boundaryIndex + boundaryBuffer.length;
            const headerEndIndex = buffer.indexOf(headerEndMarker, headerStart);

            if (headerEndIndex === -1) {
                // Headers ainda não estão completos
                break;
            }

            // Procura pelo próximo boundary para encontrar o fim do frame
            const frameStart = headerEndIndex + headerEndMarker.length;
            const nextBoundaryIndex = buffer.indexOf(boundaryBuffer, frameStart);

            if (nextBoundaryIndex === -1) {
                // Frame não está completo
                break;
            }

            // Extrai o frame JPEG (removendo trailing CRLF)
            let frameEnd = nextBoundaryIndex;
            if (buffer[frameEnd - 1] === 0x0a && buffer[frameEnd - 2] === 0x0d) {
                frameEnd -= 2;
            }

            const frameData = buffer.subarray(frameStart, frameEnd);

            // Emite o frame
            const frame: IJPEGFrame = {
                data: Buffer.from(frameData),
                timestamp: Date.now()
            };
            this.emit('frame', frame);

            // Avança a posição
            position = nextBoundaryIndex;
            processedBytes = position;
        }

        // Retorna o buffer com os dados já processados removidos
        if (processedBytes > 0) {
            return buffer.subarray(processedBytes);
        }

        return buffer;
    }
}
