import amqp from 'amqplib';

export default class AtalaiaAMQP {
    private connection: amqp.ChannelModel | null = null;
    private channel: amqp.Channel | null = null;

    constructor(public readonly url: string) { }

    async connect() {
        this.connection = await amqp.connect(this.url);
        this.channel = await this.connection.createChannel();
        await this.channel.assertQueue('movement', { durable: true });
        await this.channel.assertExchange('object', 'direct', { durable: false });
        await this.channel.assertQueue('person', { durable: true });
        await this.channel.bindQueue('person', 'object', 'person');
        await this.channel.assertQueue('manual', { durable: true });
        await this.channel.bindQueue('manual', 'object', 'manual');
    }

    notifyMovement(arquivo: string) {
        if (!this.channel) {
            throw new Error('AMQP channel is not connected.');
        }

        if (!this.channel.publish('', 'movement', Buffer.from(arquivo))) {
            throw new Error('Error publishing movement message to AMQP.');
        }
    }

    notifyPerson(arquivo: string) {
        if (!this.channel) {
            throw new Error('AMQP channel is not connected.');
        }

        if (!this.channel.publish('object', 'person', Buffer.from(arquivo), { persistent: true })) {
            throw new Error('Error publishing person message to AMQP.');
        }
    }

    notifyManual(arquivo: string) {
        if (!this.channel) {
            throw new Error('AMQP channel is not connected.');
        }

        if (!this.channel.publish('object', 'manual', Buffer.from(arquivo), { persistent: true })) {
            throw new Error('Error publishing manual message to AMQP.');
        }
    }

    async disconnect() {
        if (this.channel) {
            await this.channel.close();
            this.channel = null;
        }
        if (this.connection) {
            await this.connection.close();
            this.connection = null;
        }
    }
}