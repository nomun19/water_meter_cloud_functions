const admin = require('firebase-admin');
const functions = require('firebase-functions');
const mqtt = require('mqtt');
const qr = require('qrcode');
const Jimp = require('jimp');
const QrCode = require('qrcode-reader');
const { error } = require('firebase-functions/logger');
const { Firestore } = require("firebase-admin/firestore")

const mqttTopic = 'data';
var options = {
    host: 'cec2b4b67ccd4fa59035b6b50163d86b.s1.eu.hivemq.cloud',
    port: 8883,
    protocol: 'mqtts',
    username: 'hivemq.webclient.1719356705722',
    password: '&<f:@z4ygKeoXQW5F98S'
}

/**
 * Initialize the configurations
 */
const mqttClient = mqtt.connect(options);
admin.initializeApp();

/**
 * interact with firestore
 */


async function getUserList() {
    const snapshot = await admin.firestore().collection('users').get();
    var dataList = [];
    snapshot.forEach(doc => {
        dataList.push(doc.data());
    });
    return dataList;
}

async function getSensorList() {
    const result = await admin.firestore().collection('sensors').get();
    let dataList = [];
    if (!result.empty) {
        result.forEach( doc => {
            dataList.push(doc.data());
        });
    }
    console.log('sensorList ' + dataList)
    return dataList;
}

async function updateSensorCurrentUsage(sensorId, oldValue,  currentUsage) {
    if (!sensorId) {
        throw new Error('SensorId is empty')
    }
    if (oldValue < currentUsage ){
        await admin.firestore().collection('sensors').doc(sensorId).update({
            "currentUsage": currentUsage,
            "lastUpdatedDate": Firestore.FieldValue.serverTimestamp()
        });
        console.log(`Current usage of sensor has sucessfully updated. sensorId: ${sensorId}, oldValue: ${oldValue} newValue: ${currentUsage}`);
    }
}

async function addDeviceRelation(sensorId, uuid, name){
    const sensorData = admin.firestore().collection('sensors').doc(sensorId);
    const result = await sensorData.get();
    if (result.exists){
        const data  = result.data();
        const deviceRelations = data.deviceRelations || {}
        
        if (deviceRelations[uuid]) {
            console.log(`UserId ${uuid} already linked to the device`);
        } else {
            console.log(`userId ${uuid} does not exist, add new relation`);
            const time = Firestore.FieldValue.serverTimestamp()
            deviceRelations[uuid] = {
                name: name,
                createdAt: time
            };
            await sensorData.update({deviceRelations});
        }
    }
}


/**
 * Other useful functions
 */


function checkSensor(sensorId) {
    return getSensorList().then(sensorList => {
        return sensorList.find(sensor => sensor.sensorId == sensorId);
    });
}

/**
 * Endpoints
 */

exports.getUsers = functions.https.onRequest(async (request, response) => {
    try {
        const result = await getUserList();
        response.send(result);
    } catch (error) {
        console.error(error);
        response.status(500).send('Error retrieving users');
    }
});

exports.getSensorList = functions.https.onRequest(async (request, response) => {
    try {
        const result = await getSensorList();
        response.send(result);
    } catch (error) {
        console.err(error);
        response.status(500).send('Error retrieving sensor list');
    }
})

exports.generateQrCode = functions.https.onRequest(async (request, response) => {
    try {
        const sensorId = request.query.sensorId;
        if (!sensorId) {
            response.status(400).send('SensorId parameter is missing');
            return;
        }
        const qrString = await generateQRCode(sensorId);
        // response.send(`<img src="${qrCodeString}" alt="QR Code for SensorId ${sensorId}" />`);
        response.send(qrString);
    } catch (error) {
        console.error('Failed to generate qrString');
        response.status(500).send('Failed to to generate QR string');
    }
})

async function getCustomerId(header, response) {
    if (!header || !header.startsWith('Bearer ')) {
        response.status(401).send('Unauthorized');
        return;
    }
    const idToken = header.split('Bearer ')[1];
    await admin.auth().verifyIdToken(idToken).then(decodedToken => {
        return decodedToken.uuid;
    }).catch (error => {
        console.error(`Failed to verifying token: ${error}`);
        response.status(403).send('Unauthorized');
    })
}

function getBearerToken(request) {
    const authHeader = request.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        return authHeader.split('Bearer ')[1];
    }
    return null;
}

exports.decodeQr = functions.https.onRequest (async (request, response) => {
    // admin.auth().verifyIdToken(request.headers.authorization)
    // .then(decodedToken => {
        const decodedToken = await admin.auth().verifyIdToken(getBearerToken(request));

        // // const customerId = getCustomerId(request.headers.authorization, response).then( customerId => {
            // console.log(decodedToken);
            const customerId = decodedToken.uid;
            console.log(customerId);
        
            const qrString = request.body.qrString;
            const deviceName = request.body.name;
            console.log(qrString);
            if (!qrString) {
                response.status(400).send('QrSting has to be not null');
                return;
            }
            try {
                const sensorId = decodeQrString(qrString).then(sensorId => {
                    console.log(sensorId);
                    addDeviceRelation('sensorId' + sensorId, customerId, deviceName);
                    response.send(sensorId);
                }).catch(error => {
                    console.log('failed to decode the qr');
                })
            } catch(error) {
                console.error('Failed to decode qr');
                response.status(500).send('Failed to decode qr string');
            }
        // }).catch(error => {
        //     console.log('error');
        // })
        
    // }).catch(error => {
    //     console.log('Failed to get user token' + error);
    //     response.status(403).send('Unauthorized');
    // });
    
})

/**
 * MQTT broker code
 */

mqttClient.on('connect', () => {
    console.log('MQTT client connected');
    mqttClient.subscribe(mqttTopic, (err) => {
        if (err) {
            console.error('Failed to subscribe to topic:', mqttTopic, err);
        } else {
            console.log('Subscribed to topic:', mqttTopic);
        }
    });
});

mqttClient.on('message', async (topic, message) => {
    console.log('Received message:', topic, message.toString());

    const data = JSON.parse(message);
    try {
        const sensor = await checkSensor(data.sensorId);
        const sensorId = 'sensorId' + data.sensorId;
        if (sensor) {
            console.log(`Already exist the data ${sensor}`);
            updateSensorCurrentUsage(sensorId, sensor.currentUsage, data.currentUsage)
        } else {
            console.log(`Not exist sensorId: ${sensorId}`);
            console.log(sensorId);
            const finalData = {
                ...data,
                createdAt: Firestore.FieldValue.serverTimestamp(),
                lastUpdatedDate: Firestore.FieldValue.serverTimestamp()
            }
            await admin.firestore().collection('sensors').doc(sensorId).set(finalData);
            console.log(`Sensor data saved with sensorId: ${sensorId}`);
        }
    } catch (error) {
        console.error('Error checking sensor:',data.sensorId, error);
    }
});

mqttClient.on('error', (error) => {
    console.error('MQTT client error:', error);
});

mqttClient.on('close', () => {
    console.log('MQTT client connection closed');
});

mqttClient.on('reconnect', () => {
    console.log('MQTT client reconnecting');
});

mqttClient.on('offline', () => {
    console.log('MQTT client offline');
});



/**
 * QR related code
 */

async function generateQRCode(sensorId) {
    try {
        return await qr.toDataURL(sensorId);
    } catch ( error) {
        console.log('Error geenerating QR code:', error)
        throw new Error('Failed to generate QR code')
    }
}

async function decodeQrString(qrString) {
    try {
        let buffer;
        if (qrString.startsWith('data:image')) {
            const base64Data = qrString.split(',')[1];
            buffer = Buffer.from(base64Data, 'base64');
        } else {
            buffer = Buffer.from(qrString, 'base64');
        }
        const image = await Jimp.read(buffer);
        const qr = new QrCode();
        return new Promise((resolve, reject) => {
            qr.callback = (err, value) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(value.result);
                }
            };
            qr.decode(image.bitmap);
        });
    } catch (error) {
        console.error('Error decoding QR code:', error);
        throw new Error('Failed to decode QR code');
    }
}

