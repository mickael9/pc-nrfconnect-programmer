/* Copyright (c) 2015 - 2017, Nordic Semiconductor ASA
 *
 * All rights reserved.
 *
 * Use in source and binary forms, redistribution in binary form only, with
 * or without modification, are permitted provided that the following conditions
 * are met:
 *
 * 1. Redistributions in binary form, except as embedded into a Nordic
 *    Semiconductor ASA integrated circuit in a product or a software update for
 *    such product, must reproduce the above copyright notice, this list of
 *    conditions and the following disclaimer in the documentation and/or other
 *    materials provided with the distribution.
 *
 * 2. Neither the name of Nordic Semiconductor ASA nor the names of its
 *    contributors may be used to endorse or promote products derived from this
 *    software without specific prior written permission.
 *
 * 3. This software, with or without modification, must only be used with a Nordic
 *    Semiconductor ASA integrated circuit.
 *
 * 4. Any software provided in binary form under this license must not be reverse
 *    engineered, decompiled, modified and/or disassembled.
 *
 * THIS SOFTWARE IS PROVIDED BY NORDIC SEMICONDUCTOR ASA "AS IS" AND ANY EXPRESS OR
 * IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF
 * MERCHANTABILITY, NONINFRINGEMENT, AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL NORDIC SEMICONDUCTOR ASA OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR
 * TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
 * THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

import { logger } from 'nrfconnect/core';
import nrfjprog from 'pc-nrfjprog-js';
import MemoryMap from 'nrf-intel-hex';
import { checkUpToDateFiles } from './files';
import memRegions from '../memRegions';

// Get some useful strings from the constants in jprog.
function getDeviceModel(deviceInfo) {
    const deviceModels = {
        [nrfjprog.NRF51_FAMILY]: {
            [nrfjprog.NRF51xxx_xxAA_REV1]: 'NRF51xxx_xxAA_REV1',
            [nrfjprog.NRF51xxx_xxAA_REV2]: 'NRF51xxx_xxAA_REV2',
            [nrfjprog.NRF51xxx_xxAA_REV3]: 'NRF51xxx_xxAA_REV3',
            [nrfjprog.NRF51801_xxAB_REV3]: 'NRF51801_xxAB_REV3',
            [nrfjprog.NRF51802_xxAA_REV3]: 'NRF51802_xxAA_REV3',
            [nrfjprog.NRF51xxx_xxAB_REV3]: 'NRF51xxx_xxAB_REV3',
            [nrfjprog.NRF51xxx_xxAC_REV3]: 'NRF51xxx_xxAC_REV3',
        },
        [nrfjprog.NRF52_FAMILY]: {
            [nrfjprog.NRF52810_xxAA_FUTURE]: 'NRF52810_xxAA_FUTURE',
            [nrfjprog.NRF52832_xxAA_ENGA]: 'NRF52832_xxAA_ENGA',
            [nrfjprog.NRF52832_xxAA_ENGB]: 'NRF52832_xxAA_ENGB',
            [nrfjprog.NRF52832_xxAA_REV1]: 'NRF52832_xxAA_REV1',
            [nrfjprog.NRF52832_xxAB_REV1]: 'NRF52832_xxAB_REV1',
            [nrfjprog.NRF52832_xxAA_FUTURE]: 'NRF52832_xxAA_FUTURE',
            [nrfjprog.NRF52832_xxAB_FUTURE]: 'NRF52832_xxAB_FUTURE',
            [nrfjprog.NRF52840_xxAA_ENGA]: 'NRF52840_xxAA_ENGA',
            [nrfjprog.NRF52810_xxAA_REV1]: 'NRF52810_xxAA_REV1',
            [nrfjprog.NRF52840_xxAA_FUTURE]: 'NRF52840_xxAA_FUTURE',
        },
    };

    if (deviceInfo.family in deviceModels &&
        deviceInfo.deviceType in deviceModels[deviceInfo.family]) {
        return deviceModels[deviceInfo.family][deviceInfo.deviceType];
    }
    return 'Unknown model';
}

function getDeviceInfo(serialNumber) {
    return new Promise((resolve, reject) => {
        nrfjprog.getProbeInfo(serialNumber, (err1, probeInfo) => {
            if (err1) {
                reject(err1);
            } else {
                logger.info('Segger serial: ', probeInfo.serialNumber);
                logger.info('Segger speed: ', probeInfo.clockSpeedkHz, ' kHz');
                logger.info('Segger version: ', probeInfo.firmwareString);

                nrfjprog.getDeviceInfo(serialNumber, (err2, devInfo) => {
                    if (err2) {
                        reject(err2);
                    } else {
                        logger.info(`Probed ${serialNumber}. Model: ${getDeviceModel(devInfo)}. ` +
                        `RAM: ${devInfo.ramSize / 1024}KiB. Flash: ${devInfo.codeSize / 1024}KiB in pages of ` +
                        `${devInfo.codePageSize / 1024}KiB.`);

                        logger.info('Reading device non-volatile memory. This may take a few seconds.');

                        resolve(devInfo);
                    }
                });
            }
        });
    });
}


function getDeviceMemMap(serialNumber, devInfo) {
    return new Promise((resolve, reject) => {
        nrfjprog.read(serialNumber, devInfo.codeAddress, devInfo.codeSize, (err1, flashBytes) => {
            if (err1) {
                reject(err1);
            } else {
                nrfjprog.read(serialNumber, devInfo.uicrAddress, devInfo.infoPageSize,
                (err2, uicrBytes) => {
                    if (err2) {
                        reject(err2);
                    } else {
                        const memMap = MemoryMap.fromPaddedUint8Array(
                            new Uint8Array(flashBytes), 0xFF, 256,
                        );
                        memMap.set(devInfo.uicrAddress, new Uint8Array(uicrBytes));

                        logger.info(`Non-volatile memory has been read. ${memMap.size} non-empty memory blocks identified.`);

                        const { regions, labels } = memRegions(memMap, devInfo.uicrAddress);

                        resolve({
                            memMap,
                            regions,
                            labels,
                        });
                    }
                });
            }
        });
    });
}


// Display some information about a devkit. Called on a devkit connection.
// This also triggers reading the whole memory contents of the device.
export function logDeviceInfo(serialNumber, comName) {
    return dispatch => {
        getDeviceInfo(serialNumber)
            .then(info => {
                let targetFamily;
                if (info.family === nrfjprog.NRF51_FAMILY) {
                    targetFamily = 'nRF51';
                } else if (info.family === nrfjprog.NRF52_FAMILY) {
                    targetFamily = 'nRF52';
                }

                // Suggestion: Do this the other way around. F.ex. dispatch a
                // LOAD_TARGET_INFO action, listen to LOAD_TARGET_INFO_SUCCESS
                // in middleware and log it from there?
                dispatch({
                    type: 'TARGET_SIZE_KNOWN',
                    targetPort: comName,
                    targetSize: info.codeSize,
                    targetPageSize: info.codePageSize,
                });

                getDeviceMemMap(serialNumber, info).then(contents => {
                    dispatch({
                        type: 'TARGET_CONTENTS_KNOWN',
                        targetPort: comName,
                        targetSize: info.codeSize,
                        targetPageSize: info.codePageSize,
                        targetMemMap: contents.memMap,
                        targetRegions: contents.regions,
                        targetLabels: contents.labels,
                    });
                });
            })
            .catch(error => {
                logger.error(`Could not fetch memory size of target devkit: ${error.message}`);
            });
    };
}


// // Previous write function - manual erase and write of each page.
// function writeBlock(serialNumber, pages, dispatch) {
//
//     const pageWriteCalls = Array.from(pages.entries()).map(
//         ([address, page]) => function writeOnePage(callback) {
//             const pageStart = address;
//             const pageSize = page.length;
//             const pageEnd = pageStart + pageSize;
//
//             console.log(`Erasing 0x${hexpad(pageStart)}-0x${hexpad(pageEnd)}`);
//             logger.info(`Erasing 0x${hexpad(pageStart)}-0x${hexpad(pageEnd)}`);
//
//             nrfjprog.erase(serialNumber, {
//                 erase_mode: nrfjprog.ERASE_PAGES_INCLUDING_UICR,
//                 start_address: pageStart,
//                 // Legacy (bugged) property name, see https://github.com/NordicSemiconductor/pc-nrfjprog-js/pull/7
//                 start_adress: pageStart,
//                 end_address: pageEnd,
//             }, err => {
//                 if (err) {
//                     console.error(err);
//                     console.error(err.log);
//                     logger.error(err.log);
//                 } else {
//                     console.log(`Writing 0x${hexpad(pageStart)}-0x${hexpad(pageEnd)}`);
//                     logger.info(`Writing 0x${hexpad(pageStart)}-0x${hexpad(pageEnd)}`);
//
//                     nrfjprog.write(serialNumber, pageStart, Array.from(page), err2 => {
//                         if (err2) {
//                             console.error(err2);
//                             console.error(err2.log);
//                             logger.error(err2);
//                         } else {
//                             dispatch({
//                                 type: 'write-progress',
//                                 address: pageEnd,
//                             });
//
//                             requestAnimationFrame(() => { callback(); });
//     //                             requestAnimationFrame(() => { writeBlockClosure(); });
//                         }
//                     });
//                 }
//             });
//         }
//     );
//
//     return function writeBlockClosure() {
// //         const addresses = Array.from(appState.blocks.keys());
//
//         const pageWriteCall = pageWriteCalls.shift();
//
//         if (!pageWriteCall) {
//             console.log('Finished erasing/writing.');
//             console.log('Finished erasing/writing.');
//             dispatch({
//                 type: 'write-progress-finished',
//             });
//         } else {
//             pageWriteCall(writeBlockClosure);
//         }
//     };
// }


// Sends a .hex string to jprog.program()
function writeHex(serialNumber, hexString, dispatch) {
    nrfjprog.program(serialNumber, hexString, {
        inputFormat: nrfjprog.INPUT_FORMAT_HEX_STRING,
        chip_erase_mode: nrfjprog.ERASE_PAGES,

    }, progress => { // Progress callback
//         console.log(`Programming progress: 0x${hexpad(pageStart)}-0x${hexpad(pageEnd)}`);
//         console.log('Programming progress: ', progress);
        logger.info(progress.process);

//         dispatch({
//             type: 'write-progress',
//             address: pageEnd,
//         });
    }, err => {   // Finish callback
        if (err) {
            console.error(err);
            console.error(err.log);
            err.log.split('\n').forEach(line => logger.error(line));
//             logger.error(err.log);
            return;
        }
//         console.log(`Programming progress: 0x${hexpad(pageStart)}-0x${hexpad(pageEnd)}`);
//         console.log('Programming finished: ');
//         logger.info(`Erasing 0x${hexpad(pageStart)}-0x${hexpad(pageEnd)}`);

        logger.info('Write procedure finished');

        dispatch({
            type: 'WRITE_PROGRESS_FINISHED',
        });
    });
}


// Whether the current hex files can be written to the current target.
// Returns a boolean.
// The typical use case is having some .hex files that use the UICR, and a DevKit
// that doesn't allow erasing the UICR page(s). Also, the (rare) cases where the
// nRF SoC has readback protection enabled (and the loaded .hex files write the
// readback-protected region).
// In all those cases, this function will return false, and the user should not be
// able to press the "program" button.
// There are also instances where the UICR can be erased and overwritten, but
// unfortunately the casuistics are just too complex.
export function canWrite(appState) {
    const loaded = appState.file.loaded;
    const target = appState.target;

        // TODO: get the UICR address from the target definition. This value
        // works for nRF51s and nRF52s, but other targets might use a different one!!!
    const uicrAddr = 0x10001000;
    const uicrSize = 0x400;

    // Check if target's UICR is already erased (all 0xFFs)
    const blankUicr = new MemoryMap([[uicrAddr, (new Uint8Array(uicrSize)).fill(0xFF)]]);
    if (target.memMap.contains(blankUicr)) {
        console.log('canWrite: true (blank UICR)');
        return true;
    }

    const flattenedFiles = MemoryMap.flattenOverlaps(
            MemoryMap.overlapMemoryMaps(appState.file.memMaps),
        );

    const uicrUpdates = flattenedFiles.slice(uicrAddr, uicrSize);

    if (!target.memMap.contains(uicrUpdates)) {
            // UICR is different, and must be erased first.
            // This will also fail if the target's UICR hasn't been (or cannot be) read.
        console.log('canWrite: false (must erase all)');
        return false;
    }

        // UICR is either not present in the files, or matches the device exactly.
    console.log('canWrite: true (no UICR updates)');
    return true;
}


// Does some sanity checks, joins the loaded .hex files, flattens overlaps,
// paginates the result to fit flash pages, and calls writeHex()
export function write() {
    return (dispatch, getState) => {
        const appState = getState().app;
        const serialNumber = appState.target.serialNumber;
        const pageSize = appState.target.pageSize;
        const uicrAddr = 0x10001000;
        const uicrSize = 0x400;

        if (!serialNumber || !pageSize) {
            logger.error('Select a device before writing');
            return;
        }

        // Sanity check. Should never happen, as any write operations should be already
        // disabled in the UI.
        if (!canWrite(appState)) {
            logger.error('Can not write in the current state. Try erasing all non-volatile memory in the target.');
            return;
        }

        /// FIXME: Check if the target's UICR is blank. If not, slice the flattened
        /// hex files so that the code doesn't try to overwrite UICR.
        /// This is part of the «UICR can only be written to after an "erase all"» logic

        checkUpToDateFiles(dispatch, getState).then(() => {
            let pages = MemoryMap.flattenOverlaps(
                MemoryMap.overlapMemoryMaps(appState.file.memMaps),
            ).paginate(pageSize);

            // Check if target's UICR is already erased (all 0xFFs)
            const blankUicr = new MemoryMap([[uicrAddr, (new Uint8Array(uicrSize)).fill(0xFF)]]);
            if (!appState.target.memMap.contains(blankUicr)) {
                // Because canWrite() has been run, we can be sure that the UICR in the flattened
                // hex files is the same as the non-blank UICR of the target.
                logger.info('Target\'s UICR is not blank, skipping UICR updates.');
                console.log('Target\'s UICR is not blank, skipping UICR updates.');
                pages = pages.slice(0, uicrAddr);
            }

//         console.log(pages);
//         console.log(arraysToHex(pages, 64));

//         const writeBlockClosure = writeBlock(serialNumber, pages, dispatch);
//         writeBlockClosure();

            dispatch({
                type: 'WRITE_PROGRESS_START',
            });

            writeHex(serialNumber, pages.asHexString(64), dispatch);
        }).catch(() => {});
    };
}

// Calls nrfprog.recover().
export function recover() {
    return (dispatch, getState) => {
        const appState = getState().app;
        const serialNumber = appState.target.serialNumber;
        if (!serialNumber) {
            logger.error('Select a device before recovering');
            return;
        }

        dispatch({
            type: 'WRITE_PROGRESS_START',
        });

        nrfjprog.recover(serialNumber, progress => {
            console.log('Recovery progress: ', progress);
            logger.info(progress.process);
        }, err => {
            if (err) {
                console.error(err);
                console.error(err.log);
                err.log.split('\n').forEach(logger.error);
                return;
            }

            logger.info('Recovery procedure finished');

            dispatch({
                type: 'WRITE_PROGRESS_FINISHED',
            });
        });
    };
}
