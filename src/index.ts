import AtalaiaAMQP from './AtalaiaAMQP.js';
import AtalaiaPassiveRecorder, { NotifyAs } from './AtalaiaPassiveRecorder.js';
import AtalaiaSingleRecorder from './AtalaiaSingleRecorder.js';
import DahuaConnection from './dahua/DahuaConnection.js';
import DahuaEventListener, { DahuaAction, ISmartMotionHuman, IVideoMotion } from './dahua/DahuaEventListener.js';
import DahuaSystem from './dahua/DahuaSystem.js';
import DahuaVideo from './dahua/DahuaVideo.js';
import { IAtalaiaRecorder } from './IAtalaiaRecorder.js';
import HomeAssistantIntegration from './integration/HomeAssistantIntegration.js';
import RecorderManager from './RecorderManager.js';

// const args = import('args-parser')(process.argv);

// const username = args.username ?? args.u;
// const password = args.password ?? args.p;
// const url = args.url;
// const queue = args.queue ?? args.q;
// const topic = args.topic ?? args.topic;

const {
    DAHUA_URL: url,
    DAHUA_USER: username,
    DAHUA_PASSWORD: password,
    AMQP_URL: amqpUrl,
    MOVEMENT_NOTIFY: movementNotify,
    PERSON_NOTIFY: personNotify,
    MQTT_URL: mqttUrl,
    PASSIVE: passiveRecorder,
    VIDEO_PATH: videoPath
} = process.env;

if (!url) {
    console.error('Variável de ambiente DAHUA_URL não definida.');
    process.exit(1);
}

if (!username) {
    console.error('Variável de ambiente DAHUA_USER não definida.');
    process.exit(1);
}

if (!password) {
    console.error('Variável de ambiente DAHUA_PASSWORD não definida.');
    process.exit(1);
}

if (!amqpUrl) {
    console.error('Variável de ambiente AMQP_URL não definida.');
    process.exit(1);
}

if (!mqttUrl) {
    console.error('Variável de ambiente MQTT_URL não definida.');
    process.exit(1);
}

if (!videoPath) {
    console.error('Variável de ambiente VIDEO_PATH não definida.');
    process.exit(1);
}

console.info('MQTT URL:', mqttUrl);
console.info('Video Path:', videoPath);

const atalaiaQueue = new AtalaiaAMQP(amqpUrl);

await atalaiaQueue.connect();

console.info('Conectado ao AMQP:', amqpUrl);

const connection = new DahuaConnection(url, username, password);
const system = new DahuaSystem(connection);

// console.info('Dahua Machine Name', await system.getMachineName());
system.getVendor().then(v => console.info('Dahua Vendor', v.trim()));
system.getDeviceType().then(v => console.info('Dahua Device', v.trim()));
system.getHardwareVersion().then(v => console.info('Dahua Hardware', v.trim()));
system.getSerialNumber().then(v => console.info('Dahua Serial Number', v.trim()));

const video = new DahuaVideo(connection);
const channels = await video.getChannels();

console.info('Channels', channels);

const eventListener = new DahuaEventListener(connection);

// Inicializa RecorderManager
console.info('[MAIN] Inicializando RecorderManager...');
const recorderManager = new RecorderManager({
    username,
    password,
    dahuaUrl: url,
    atalaiaQueue,
    outputDir: videoPath,
    numChannels: channels
});
console.info('[MAIN] RecorderManager criado');

// Inicializa integração Home Assistant com MQTT e RecorderManager
console.info('[MAIN] Inicializando integração Home Assistant com MQTT...');
const haIntegration = new HomeAssistantIntegration(mqttUrl, connection, eventListener, recorderManager);
console.info('[MAIN] HomeAssistantIntegration criado e configurado');

// Conecta eventos do DahuaEventListener ao RecorderManager
eventListener.addEventListener('VideoMotion', function VideoMotion(action: DahuaAction, index: number, event: IVideoMotion) {
    const channel = index + 1;
    recorderManager.onVideoMotion(channel, action, event);
});

eventListener.addEventListener('SmartMotionHuman', function SmartMotionHuman(action: DahuaAction, index: number, event: ISmartMotionHuman) {
    const channel = index + 1;
    recorderManager.onPersonDetected(channel, action, event);
});

console.info('[MAIN] Event listeners conectados ao RecorderManager');

// Função para encerrar o sistema graciosamente
async function gracefulShutdown(signal: string) {
    console.info(`\n[MAIN] Recebido sinal ${signal}, encerrando o sistema...`);
    
    try {
        // Fecha o RecorderManager (para todas as gravações)
        console.info('[MAIN] Fechando gravações...');
        recorderManager.closeAll();
        
        // Desconecta do Home Assistant/MQTT
        console.info('[MAIN] Desconectando do MQTT...');
        await haIntegration.disconnect();
        
        // Desconecta do AMQP
        console.info('[MAIN] Desconectando do AMQP...');
        await atalaiaQueue.disconnect();
        
        console.info('[MAIN] Sistema encerrado com sucesso.');
        process.exit(0);
    } catch (error) {
        console.error('[MAIN] Erro ao encerrar o sistema:', error);
        process.exit(1);
    }
}

// Trata sinais de encerramento
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGQUIT', () => gracefulShutdown('SIGQUIT'));
process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));

// Trata erros não capturados
process.on('uncaughtException', (error) => {
    console.error('[MAIN] Erro não capturado:', error);
    gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[MAIN] Promise rejeitada não tratada:', promise, 'razão:', reason);
    gracefulShutdown('unhandledRejection');
});


// const recorders: IAtalaiaRecorder[] = [];

// if (passiveRecorder?.toLowerCase() === 'true') {
//     console.info('Inicializando AtalaiaPassiveRecorder para cada canal...');

//     for (let i = 0; i < channels; i++) {
//         setTimeout(() => {
//             const recorder = new AtalaiaPassiveRecorder({
//                 videoUrl: `rtsp://${username}:${password}@${url!.replace(/^https?:\/\/([^/]+)/, '$1:554')}/cam/realmonitor?channel=${i + 1}&subtype=1`,
//                 amqpUrl,
//                 atalaiaQueue,
//                 channel: i + 1,
//                 movementNotify: movementNotify?.toLowerCase() as NotifyAs,
//                 personNotify: personNotify?.toLowerCase() as NotifyAs
//             });
//             recorders.push(recorder);
//         }, i * 5000);
//     }
// } else {
//     console.info('Inicializando AtalaiaSingleRecorder para cada canal...');

//     for (let i = 0; i < channels; i++) {
//         const recorder = new AtalaiaSingleRecorder({
//             videoUrl: `rtsp://${username}:${password}@${url!.replace(/^https?:\/\/([^/]+)/, '$1:554')}/cam/realmonitor?channel=${i + 1}&subtype=1`,
//             amqpUrl,
//             atalaiaQueue,
//             channel: i + 1
//         });
//         recorders.push(recorder);
//     }
// }

// eventListener.addEventListener('VideoMotion', function VideoMotion(action: string, index: number, event: IVideoMotion) {
//     const channel = index + 1;

//     if (event.SmartMotionEnable) {
//         return;
//     }

//     const agora = new Date().getHours();

//     if (channel > 4 && (agora < 22 || agora >= 7)) {
//         return;
//     }

//     if (recorders[index]) {
//         recorders[index].notifyMovement(event.SmartMotionEnable);
//     }
// });


// eventListener.addEventListener('SmartMotionHuman', function notifyHuman(action, index: number, event: ISmartMotionHuman) {
//     const channel = index + 1;

//     const agora = new Date().getHours();

//     if (channel > 4 && (agora < 22 || agora >= 7)) {
//         return;
//     }

//     if (recorders[index]) {
//         console.info('Human Motion Detected', index, event);
//         recorders[index].notifyPerson();
//     } else {
//         console.warn('Human Motion Detected without recorder', index, event);
//     }
// });
