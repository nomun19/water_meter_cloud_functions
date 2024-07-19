const admin = require('firebase-admin');
const functions = require('firebase-functions');
const mqtt = require('mqtt');
const qr = require('qrcode');
const Jimp = require('jimp');
const QrCode = require('qrcode-reader');
const { error } = require('firebase-functions/logger');
const { Firestore } = require("firebase-admin/firestore");
const geofire = require('geofire-common');

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
const cloudFunctions = functions.region('europe-west1');


class ResponseError{
    constructor(resultType){
        this.resultType = resultType;
    }
}

const durationType = {
    Daily: 'daily',
    Weekly: 'weekly',
    Monthly: 'monthly',
    Year: 'year'
}


function checkDuration(value){
    return Object.values(durationType).includes(value);
}


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

async function getSensorData(sensorId) {
    const sensor = await admin.firestore().collection('sensors').doc(sensorId).get();
    if (sensor.exists){
        return sensor.data();
    } return null;
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


async function getCustomersDeviceData(customerId) {
    const data = await admin.firestore().collection('sensors').where(`deviceRelations.${customerId}`, '!=', null).get();
    const result = {"sensors":[]};
    if (data){
        data.forEach((sensorDoc) => {
            const sensorData = sensorDoc.data();
            const { currentUsage, sensorId } = sensorData;
            const { name, createdAt } = sensorData.deviceRelations[customerId];
            const customAlerts = sensorData.customAlerts || [];
            const customAlertsResult = [];
            for (const [type, alertObj] of Object.entries(customAlerts)) {
                customAlertsResult.push({ type: type, value: alertObj.value });
            }
            const objData = {
                'name' : name,
                'createdAt': new Date(createdAt._nanoseconds),
                'currentUsage': currentUsage,
                'sensorId': sensorId,
                'customAlerts': customAlertsResult
            };
            result["sensors"].push(objData);
        });
    } else {
        console.log('not exist');
    }
    return result;
}

async function deleteCustomersDevice(sensorId, customerId) {
    const sensorDocRef = admin.firestore().collection('sensors').doc(sensorId);
    await sensorDocRef.update({
        [`deviceRelations.${customerId}`]: Firestore.FieldValue.delete()
    });
}

async function updateDeviceName(sensorId, customerId, name) {
    const sensorDocRef = admin.firestore().collection('sensors').doc(sensorId);
    await sensorDocRef.update({
        [`deviceRelations.${customerId}.name`]: name
    });
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


async function getSensorsAlerts(sensorId) {
    const sensorDoc = await admin.firestore().collection('sensors').doc(sensorId).get();
    const result = [];
    if (!sensorDoc.empty) {
        const sensorData = sensorDoc.data();
        const customAlerts = sensorData.customAlerts;
        for (const [type, alertObj] of Object.entries(customAlerts)) {
            result.push({ type: type, value: alertObj.value });
        }
    }
    return result;
}

async function getCustomersSensorsAlerts(customerId) {
    const sensorDoc = await admin.firestore().collection('sensors').where(`deviceRelations.${customerId}`, '!=', null).get();
    const customAlertsResult = [];
    if (sensorDoc){
        sensorDoc.forEach((sensorDoc) => {
            const sensorData = sensorDoc.data();
            const customAlerts = sensorData.customAlerts || [];
            for (const [type, alertObj] of Object.entries(customAlerts)) {
                customAlertsResult.push({ type: type, value: alertObj.value });
            }
        });
    } else {
        console.log('not exist');
    }
    return customAlertsResult;
}

async function addDeviceRelation(sensorId, uuid, name){
    const sensorData = admin.firestore().collection('sensors').doc(sensorId);
    const result = await sensorData.get();
    if (result.exists){
        const data  = result.data();
        const deviceRelations = data.deviceRelations || {}
        
        if (deviceRelations[uuid]) {
            console.log(`UserId ${uuid} already linked to the device`);
            return new ResponseError('alreadyLinkedDevice');
        } else {
            console.log(`userId ${uuid} does not exist, add new relation`);
            const time = Firestore.FieldValue.serverTimestamp();
            deviceRelations[uuid] = {
                name: name,
                createdAt: time
            };

            const writeResult = await sensorData.update({deviceRelations});
            return{
                'resultType' : 'success',
                'newSensorData' : {
                'name' : name,
                'createdAt': writeResult.writeTime.toDate(),
                'currentUsage': data.currentUsage,
                'sensorId': data.sensorId,
                'customAlerts': []
                }
            };
        }
    }
    return new ResponseError('deviceNotExist');
}

async function addCustomAlert(sensorId, customerId, value, type){
    if (checkDuration(type)){
        const sensorData = admin.firestore().collection('sensors').doc(sensorId);
        const result = await sensorData.get();
        if (result.exists){
            const data  = result.data();
            const deviceRelations = result.deviceRelations || {}
            if (deviceRelations[customerId]){
                console.log(`Customer does not connect to the device. customerId: ${customerId}, deviceId: ${sensorId}`);
                return new ResponseError('noPermission');
            }
            const customAlerts = data.customAlerts || {}
        
            if (customAlerts[type]) {
                console.log(`Type ${type} is already configured to the device`);
                return new ResponseError('alreadyExistedType');
            } else {
                console.log(`Type ${type} does not exist, add new alert on device. deviceId : ${sensorId}`);
                const time = Firestore.FieldValue.serverTimestamp();
                customAlerts[type] = {
                    value: value,
                    type: type,
                    createdAt: time
                };

                const writeResult = await sensorData.update({customAlerts});
                return{
                    'resultType' : 'success',
                    'newSensorData' : {
                    'name' : data.name,
                    'createdAt': writeResult.writeTime.toDate(),
                    'currentUsage': data.currentUsage,
                    'sensorId': data.sensorId
                    }
                };
            }
        }
    }
}


async function updateCustomAlert(sensorId, value, type) {
    const sensorDocRef = admin.firestore().collection('sensors').doc(sensorId);
    await sensorDocRef.set({
        customAlerts: {
            [type]: {
                value: value
            }
        }
    }, { merge: true });
}

async function deleteCustomAlert(sensorId, type){
    const sensorDocRef = admin.firestore().collection('sensors').doc(sensorId);
    await sensorDocRef.update({
        [`customAlerts.${type}`]: Firestore.FieldValue.delete()
    });
}

async function getSensorsNearAPoint(point, radiusInKm)
{
    console.log(point);
    console.log(radiusInKm);
    //Calculate bounding box values
    let dY = radiusInKm / 111.11;
    let dX = dY / Math.cos(geofire.degreesToRadians(point.lat));

    const results = await admin.firestore().collection('sensors')
        .orderBy("location.longitude")
        .where("location.latitude", ">=", point.lat - dY)
        .where("location.latitude", "<=", point.lat + dY)
        .where("location.longitude", ">=", point.lon - dX)
        .where("location.longitude", "<=", point.lon + dX).get();

    var dataList = {"sensors":[]};
    results.forEach(doc => {
        const data = doc.data();
        console.log(data);
        let distance = geofire.distanceBetween([data.location.latitude, data.location.longitude], [point.lat, point.lon]);
        if(distance <= radiusInKm){
            dataList["sensors"].push(doc.data());
        }
    });

    return dataList;
}


/**
 * Other useful functions
 */


function checkSensor(sensorId) {
    return getSensorList().then(sensorList => {
        return sensorList.find(sensor => sensor.sensorId == sensorId);
    });
}

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

async function getCustomerId(request) {
    const decodedToken = await admin.auth().verifyIdToken(getBearerToken(request));
    return decodedToken.uid;
}


/**
 * Endpoints
 */

exports.getSensorsNearMe = cloudFunctions.https.onRequest(async (request, response) => {
    try {
        const location = request.body.location;
        const radius = request.body.radius;
        const result = await getSensorsNearAPoint(location, radius);
        response.send(result);
    } catch (error) {
        console.error(error);
        response.status(500).send('Failed to retrieving sensors near position');
    }
});


exports.getUsers = cloudFunctions.https.onRequest(async (request, response) => {
    try {
        const result = await getUserList();
        response.send(result);
    } catch (error) {
        console.error(error);
        response.status(500).send('Error retrieving users');
    }
});

exports.getSensorList = cloudFunctions.https.onRequest(async (request, response) => {
    try {
        const result = await getSensorList();
        response.send(result);
    } catch (error) {
        console.err(error);
        response.status(500).send('Error retrieving sensor list');
    }
})

exports.generateQrCode = cloudFunctions.https.onRequest(async (request, response) => {
    try {
        const sensorId = request.query.sensorId;
        if (!sensorId) {
            response.status(400).send('SensorId parameter is missing');
            return;
        }
        const qrString = await generateQRCode(sensorId);
        response.send(`<img src="${qrString}" alt="QR Code for SensorId ${sensorId}" />`);
        // response.send(qrString);
    } catch (error) {
        console.error('Failed to generate qrString' + error);
        response.status(500).send('Failed to to generate QR string');
    }
})

exports.addDeviceRelation = cloudFunctions.https.onRequest(async (request, response) => {
    const customerId = await getCustomerId(request);
    console.log(customerId);
    const sensorId = request.body.sensorId;
    const deviceName = request.body.name;
    console.log(`receive data from `);
    if (!sensorId || !deviceName) {
        response.status(400).send(new ResponseError('missingDatas'));
        return;
    }
    try {
        console.log(sensorId);
        const deviceData = await addDeviceRelation(sensorId, customerId, deviceName);
        response.send(deviceData);
    } catch(error) {
        console.error('Failed to decode qr '+ error);
        response.status(500).send(new ResponseError('qrDecodingFailed'));
        return;
    }
})

exports.getSensorsAlertConfigs = cloudFunctions.https.onRequest(async (request, response) => {
    const customerId = await getCustomerId(request);
    const sensorId = request.query.sensorId;
    response.send(await getSensorsAlerts(sensorId));
})

exports.getSensorsAlertsConfigsForWeb = cloudFunctions.https.onRequest(async (request, response) => {
    const sensorId = request.query.sensorId;
    response.send(await getSensorsAlerts(sensorId));
})

exports.getCustomersCustomAlerts = cloudFunctions.https.onRequest(async (request, response) => {
    const customerId = request.query.customerId;
    response.send(await getCustomersSensorsAlerts(customerId));
})

exports.customersDeviceList = cloudFunctions.https.onRequest(async (request, response) => {
    const customerId = await getCustomerId(request);
    return response.send(await getCustomersDeviceData(customerId));
})

exports.deleteDeviceRelation = cloudFunctions.https.onRequest(async (request, response) => {
    const customerId = await getCustomerId(request);
    const sensorId = request.body.sensorId;
    return response.send(await deleteCustomersDevice(sensorId, customerId));
})

exports.updateDeviceName = cloudFunctions.https.onRequest(async (request, response) => {
    const customerId = await getCustomerId(request);
    const sensorId = request.body.sensorId;
    const newName = request.body.name;
    return response.send(await updateDeviceName(sensorId, customerId, newName));
})


exports.addAlert = cloudFunctions.https.onRequest(async (request, response) => {
    const customerId = await getCustomerId(request);
    const { sensorId, value, type } = request.body;
    return response.send(await addCustomAlert(sensorId, customerId, value, type));
})

exports.updateAlert = cloudFunctions.https.onRequest(async (request, response) => {
    const customerId = await getCustomerId(request);
    const { sensorId, value, type } = request.body;
    try {
        await updateCustomAlert(sensorId, value, type)
        return response.send();
    } catch(e){
        response.status(500).send(new ResponseError('failedToUpdateCustomAlert'));
        return;
    }
})

exports.deleteAlert = cloudFunctions.https.onRequest(async (request, response) => {
    const customerId = await getCustomerId(request);
    const { sensorId, type } = request.body;
    return response.send(await deleteCustomAlert(sensorId, type));
})


/**
 * MQTT broker code
 */

// mqttClient.on('connect', () => {
//     console.log('MQTT client connected');
//     mqttClient.subscribe(mqttTopic, (err) => {
//         if (err) {
//             console.error('Failed to subscribe to topic:', mqttTopic, err);
//         } else {
//             console.log('Subscribed to topic:', mqttTopic);
//         }
//     });
// });

// mqttClient.on('message', async (topic, message) => {
//     console.log('Received message:', topic, message.toString());

//     const data = JSON.parse(message);
//     try {
//         const finalData = {
//             sensorId: 'sensorId' + data.sensorId,
//             recordedDate: data.recordedDate,
//             currentUsage: data.currentUsage,
//             createdAt: Firestore.FieldValue.serverTimestamp()
//         }
//         await admin.firestore().collection('logs').add(finalData);
//         console.log(`Sensor data saved with sensorId: ${data.sensorId}`);
//     } catch (error) {
//         console.error('Error checking sensor:',data.sensorId, error);
//     }
// });

// mqttClient.on('error', (error) => {
//     console.error('MQTT client error:', error);
// });

// mqttClient.on('close', () => {
//     console.log('MQTT client connection closed');
// });

// mqttClient.on('reconnect', () => {
//     console.log('MQTT client reconnecting');
// });

// mqttClient.on('offline', () => {
//     console.log('MQTT client offline');
// });



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

