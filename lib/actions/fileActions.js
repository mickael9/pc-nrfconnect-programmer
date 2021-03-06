/* Copyright (c) 2015 - 2018, Nordic Semiconductor ASA
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

import { readFile, stat, statSync } from 'fs';
import { basename } from 'path';
import electron from 'electron';
import Store from 'electron-store';
import { List, Set } from 'immutable';
import { logger } from 'nrfconnect/core';
import MemoryMap from 'nrf-intel-hex';
import { hexpad8 } from '../util/hexpad';
import { getFileRegions, RegionName, RegionColor } from '../util/regions';
import * as targetActions from './targetActions';
import { addFileWarning, fileWarningRemoveAction } from './warningActions';

const persistentStore = new Store({ name: 'nrf-programmer' });

export const ERROR_DIALOG_SHOW = 'ERROR_DIALOG_SHOW';
export const FILE_PARSE = 'FILE_PARSE';
export const FILE_REMOVE = 'FILE_REMOVE';
export const FILES_EMPTY = 'FILES_EMPTY';
export const FILE_REGIONS_KNOWN = 'FILE_REGIONS_KNOWN';
export const FILE_REGION_NAMES_KNOWN = 'FILE_REGION_NAMES_KNOWN';
export const MRU_FILES_LOAD_SUCCESS = 'MRU_FILES_LOAD_SUCCESS';

export function errorDialogShowAction(error) {
    return {
        type: ERROR_DIALOG_SHOW,
        message: error.message || error,
    };
}

export function fileParseAction(loaded, memMaps) {
    return {
        type: FILE_PARSE,
        loaded,
        memMaps,
    };
}

export function fileRegionsKnownAction(regions) {
    return {
        type: FILE_REGIONS_KNOWN,
        regions,
    };
}

export function fileRegionNamesKnownAction(detectedRegionNames) {
    return {
        type: FILE_REGION_NAMES_KNOWN,
        detectedRegionNames,
    };
}

export function filesEmptyAction() {
    return {
        type: FILES_EMPTY,
    };
}

export function mruFilesLoadSuccessAction(files) {
    return {
        type: MRU_FILES_LOAD_SUCCESS,
        files,
    };
}

// There is an Application on top of SoftDevice in the HEX file,
// but there is no SoftDevice in the HEX file,
// In this case, if there is a SoftDevice being found in target device,
// then the Application region should be displayed.
// If there is no SoftDevice in both HEX file and target device,
// then the user should give input instead.
// (Or fix getting softdevice id from bootloader)
function updateFileAppRegions() {
    return (dispatch, getState) => {
        const softDeviceMagicStart = 0x1000;
        let fileRegions = getState().app.file.regions;
        const targetRegions = getState().app.target.regions;
        const deviceInfo = getState().app.target.deviceInfo;

        // Assume that the region on top of the SoftDevice is application.
        // Assume also that the region on top of the MBR which is not SoftDevice is application.
        // Application can be 1 page size above or 2 page sizes above SoftDevice,
        // e.g. a HRS app with SoftDevice s140 (see version below)
        // (nRF5_SDK_15.0.0_a53641a\examples\ble_peripheral\ble_app_hrs\hex\
        // ble_app_hrs_pca10059_s140.hex)
        // SoftDevice ends with 0x253C8 while HRS app starts with 0x26000
        // e.g. a HRS app with SoftDevice s132 (see version below)
        // (nRF5_SDK_15.0.0_a53641a\examples\ble_peripheral\ble_app_hrs\hex\
        // ble_app_hrs_pca10040_s132.hex)
        // SoftDevice ends with 0x24A24 while HRS app starts with 0x26000
        // Update similar function at ../lib/regions.getRegionsFromOverlaps if need.
        const fileSoftDeviceRegion = fileRegions.find(r => r.name === RegionName.SOFTDEVICE);
        const targetSoftDeviceRegion = targetRegions.find(r => r.name === RegionName.SOFTDEVICE);
        const targetBootloaderRegion = targetRegions.find(r => r.name === RegionName.BOOTLOADER);
        const pageSize = deviceInfo.pageSize;
        if (!fileSoftDeviceRegion && targetSoftDeviceRegion) {
            const softDeviceEnd = targetSoftDeviceRegion.startAddress
                + targetSoftDeviceRegion.regionSize;
            let appRegion = fileRegions.find(r =>
                r.startAddress === Math.ceil(softDeviceEnd / pageSize) * pageSize);
            appRegion = appRegion || fileRegions.find(r =>
                r.startAddress === (Math.ceil(softDeviceEnd / pageSize) + 1) * pageSize);
            if (appRegion) {
                const appRegionIndex = fileRegions.indexOf(appRegion);
                appRegion = appRegion.set('name', RegionName.APPLICATION);
                appRegion = appRegion.set('color', RegionColor.APPLICATION);
                fileRegions = fileRegions.set(appRegionIndex, appRegion);
                dispatch(fileRegionsKnownAction(fileRegions));
            }
        }

        // Remove Application label if there is no SoftDevice region existing.
        if (!fileSoftDeviceRegion && !targetSoftDeviceRegion) {
            let appRegion = fileRegions.find(r => r.name === RegionName.APPLICATION);
            if (appRegion && appRegion.startAddress !== softDeviceMagicStart) {
                const appRegionIndex = fileRegions.indexOf(appRegion);
                appRegion = appRegion.set('name', RegionName.NONE);
                appRegion = appRegion.set('color', RegionColor.NONE);
                fileRegions = fileRegions.set(appRegionIndex, appRegion);
                dispatch(fileRegionsKnownAction(fileRegions));
            }
        }

        const regionChecklist = new List([
            RegionName.APPLICATION,
            RegionName.SOFTDEVICE,
            RegionName.BOOTLOADER,
        ]);
        let detectedRegionNames = new Set();
        let appStartAddress;
        let appEndAddress;
        fileRegions.forEach(r => {
            if (r.name && regionChecklist.includes(r.name)) {
                detectedRegionNames = detectedRegionNames.add(r.name);
            }
            if (targetBootloaderRegion &&
                r.name === RegionName.NONE &&
                r.startAddress < targetBootloaderRegion.startAddress &&
                (!appEndAddress || appEndAddress <= r.startAddress)) {
                appEndAddress = r.startAddress + r.regionSize;
            }
            if (r.name === RegionName.APPLICATION) {
                appStartAddress = r.startAddress;
            }
        });
        dispatch(fileRegionNamesKnownAction(detectedRegionNames));

        // Merge Application regions if more than one application are detected.
        if (targetBootloaderRegion &&
            appStartAddress !== undefined &&
            appEndAddress !== undefined) {
            fileRegions.forEach(r => {
                if (r.name === RegionName.NONE &&
                    r.startAddress < targetBootloaderRegion.startAddress) {
                    fileRegions = fileRegions.remove(fileRegions.indexOf(r));
                }
            });
            let appRegion = fileRegions.find(r => r.name === RegionName.APPLICATION);
            const appRegionIndex = fileRegions.indexOf(appRegion);
            appRegion = appRegion.set('regionSize', appEndAddress - appStartAddress);
            appRegion = appRegion.set('color', RegionColor.APPLICATION);
            fileRegions = fileRegions.set(appRegionIndex, appRegion);
            dispatch(fileRegionsKnownAction(fileRegions));
        }
    };
}

// Update Bootloader region in parsed files
// Regard the Bootlader as a whole when there are gaps found in the Bootloader
function updateFileBlRegion() {
    return (dispatch, getState) => {
        let fileRegions = getState().app.file.regions;
        let blRegion = fileRegions.find(r => r.name === RegionName.BOOTLOADER);
        if (!blRegion) {
            return;
        }

        const deviceInfo = getState().app.target.deviceInfo;
        const blStartAddress = blRegion.startAddress;
        let blEndAddress;
        fileRegions.forEach(r => {
            if (r.name === RegionName.NONE &&
                r.startAddress > blRegion.startAddress &&
                r.startAddress + r.regionSize < deviceInfo.romSize &&
                (!blEndAddress || blEndAddress <= r.startAddress)) {
                blEndAddress = r.startAddress + r.regionSize;
            }
        });

        // Merge Bootloader regions if more than one Bootloaders are detected.
        if (blStartAddress !== undefined && blEndAddress !== undefined) {
            fileRegions.forEach(r => {
                if (r.name === RegionName.NONE) {
                    fileRegions = fileRegions.remove(fileRegions.indexOf(r));
                }
            });
            const blRegionIndex = fileRegions.indexOf(blRegion);
            blRegion = blRegion.set('regionSize', blEndAddress - blStartAddress);
            fileRegions = fileRegions.set(blRegionIndex, blRegion);
            dispatch(fileRegionsKnownAction(fileRegions));
        }
    };
}

export function updateFileRegions() {
    return (dispatch, getState) => {
        dispatch(fileWarningRemoveAction());

        const { file, target } = getState().app;
        const overlaps = MemoryMap.overlapMemoryMaps(file.memMaps);
        const regions = getFileRegions(file.memMaps, target.deviceInfo);

        // Show file warning if overlapping.
        if (regions.find(r => r.fileNames && r.fileNames.length > 1)) {
            dispatch(addFileWarning('Some of the HEX files have overlapping data.'));
        }

        // Show file warning if out of displaying area.
        const outsideFlashBlocks = [];
        overlaps.forEach((overlap, startAddress) => {
            const endAddress = startAddress + overlap[0][1].length;
            const { uicrBaseAddr, romSize, pageSize } = target.deviceInfo;
            if ((startAddress < uicrBaseAddr && endAddress > romSize) ||
                (startAddress >= uicrBaseAddr && endAddress > uicrBaseAddr + pageSize)) {
                outsideFlashBlocks.push(`${hexpad8(startAddress)}-${hexpad8(endAddress)}`);
            }
        });
        if (outsideFlashBlocks.length) {
            dispatch(addFileWarning(`There is data outside the user-writable areas (${outsideFlashBlocks.join(', ')}).`));
        }

        dispatch(fileRegionsKnownAction(regions));
        dispatch(updateFileBlRegion());
        dispatch(updateFileAppRegions());
    };
}

export function removeFile(filePath) {
    return (dispatch, getState) => {
        const { loaded, memMaps } = getState().app.file;
        const newLoaded = { ...loaded };
        const newMemMaps = memMaps.filter(element => element[0] !== filePath);
        delete newLoaded[filePath];

        dispatch(fileParseAction(newLoaded, newMemMaps));
        dispatch(updateFileRegions());
        dispatch(targetActions.updateTargetWritable());
    };
}

export function closeFiles() {
    return dispatch => {
        dispatch(fileWarningRemoveAction());
        dispatch(filesEmptyAction());
        dispatch(updateFileRegions());
        dispatch(targetActions.updateTargetWritable());
    };
}

export function loadMruFiles() {
    return dispatch => {
        const files = persistentStore.get('mruFiles', []);
        dispatch(mruFilesLoadSuccessAction(files));
    };
}

function removeMruFile(filename) {
    const files = persistentStore.get('mruFiles', []);
    persistentStore.set('mruFiles', files.filter(file => file !== filename));
}

function addMruFile(filename) {
    const files = persistentStore.get('mruFiles', []);
    if (files.indexOf(filename) === -1) {
        files.unshift(filename);
        files.splice(10);
        persistentStore.set('mruFiles', files);
    }
}

function parseOneFile(filePath) {
    return async (dispatch, getState) => {
        const { loaded, memMaps } = getState().app.file;
        if (loaded[filePath]) {
            return;
        }

        stat(filePath, (statsError, stats) => {
            if (statsError) {
                logger.error(`Could not open HEX file: ${statsError}`);
                dispatch(errorDialogShowAction(statsError));
                removeMruFile(filePath);
                return;
            }

            readFile(filePath, {}, (readError, data) => {
                logger.info('Parsing HEX file: ', filePath);
                logger.info('File was last modified at ', stats.mtime.toLocaleString());
                if (readError) {
                    logger.error(`Could not open HEX file: ${readError}`);
                    dispatch(errorDialogShowAction(readError));
                    removeMruFile(filePath);
                    return;
                }
                addMruFile(filePath);

                let memMap;
                try {
                    memMap = MemoryMap.fromHex(data.toString());
                } catch (e) {
                    logger.error(`Could not open HEX file: ${e}`);
                    dispatch(errorDialogShowAction(e));
                    return;
                }

                memMap.forEach((block, address) => {
                    const size = block.length;
                    logger.info('Data block: ' +
                        `${hexpad8(address)}-${hexpad8(address + size)} (${hexpad8(size)}`,
                        ' bytes long)');
                });

                const newLoaded = {
                    ...loaded,
                    [filePath]: {
                        filename: basename(filePath),
                        modTime: stats.mtime,
                        loadTime: new Date(),
                        memMap,
                    },
                };
                const newMemMaps = [
                    ...memMaps,
                    [filePath, memMap],
                ];
                dispatch(fileParseAction(newLoaded, newMemMaps));
                dispatch(updateFileRegions());
                dispatch(targetActions.updateTargetWritable());
            });
        });
    };
}

export function openFileDialog() {
    return dispatch => {
        electron.remote.dialog.showOpenDialog(
            {
                title: 'Select a HEX file',
                filters: [{ name: 'Intel HEX files', extensions: ['hex', 'ihex'] }],
                properties: ['openFile', 'multiSelections'],
            },
            filenames => {
                filenames.forEach(filename => {
                    dispatch(parseOneFile(filename));
                });
            });
    };
}

export function openFile(filename) {
    return dispatch => {
        dispatch(parseOneFile(filename));
        dispatch(loadMruFiles());
    };
}

export function refreshAllFiles() {
    return (dispatch, getState) => Promise.all(
        Object.keys(getState().app.file.loaded).map(async filePath => {
            const entry = getState().app.file.loaded[filePath];
            try {
                const stats = statSync(filePath);
                if (entry.loadTime.getTime() < stats.mtime) {
                    logger.info('Reloading: ', filePath);
                    await dispatch(parseOneFile(filePath));
                    return;
                }
                logger.info('Does not need to be reloaded: ', filePath);
            } catch (error) {
                logger.error(`Could not open HEX file: ${error}`);
                dispatch(errorDialogShowAction(error));
            }
        }));
}

// Checks if the files have changed since they were loaded into the programmer UI.
// Will display a message box dialog.
// Expects a Map of filenames to instances of Date when the file was loaded into the UI.
// Returns a promise: it will resolve when the state of the files is known, or
// reject if the user wanted to cancel to manually check the status.
export function checkUpToDateFiles(dispatch, getState) {
    const { loaded } = getState().app.file;
    let newestFileTimestamp = -Infinity;

    // Check if files have changed since they were loaded
    return Promise.all(
        Object.keys(loaded).map(filePath => new Promise(resolve => {
            stat(filePath, (err, stats) => {
                if (loaded[filePath].loadTime.getTime() < stats.mtime) {
                    newestFileTimestamp = Math.max(newestFileTimestamp, stats.mtime);
                    resolve(filePath);
                } else {
                    resolve();
                }
            });
        })),
    ).then(filenames => filenames.filter(i => !!i)).then(filenames => {
        if (filenames.length === 0) {
            // Resolve immediately: no files were changed
            return Promise.resolve();
        }

        if (persistentStore.has('behaviour-when-files-not-up-to-date')) {
            // If the user has checked the "don't ask me again" checkbox before,
            // perform the saved behaviour
            const behaviour = persistentStore.get('behaviour-when-files-not-up-to-date');
            if (behaviour === 'ignore') {
                return Promise.resolve();
            } else if (behaviour === 'reload') {
                return dispatch(refreshAllFiles());
            }
        }

        return new Promise((res, rej) => {
            const lastLoaded = (new Date(newestFileTimestamp)).toLocaleString();

            electron.remote.dialog.showMessageBox({
                type: 'warning',
                buttons: [
                    `Use old version (prior to ${lastLoaded})`,
                    'Reload all files and proceed',
                    'Cancel',
                ],
                message: `The following files have changed on disk since they were last loaded:\n${
                    filenames.join('\n')}`,
                checkboxLabel: 'Don\'t ask again',
            }, (button, doNotAskAgain) => {
                if (doNotAskAgain) {
                    persistentStore.set('behaviour-when-files-not-up-to-date',
                        button === 0 ? 'ignore' : 'reload',
                    );
                }

                if (button === 0) { // Use old version
                    return res();
                } else if (button === 1) { // Reload
                    return dispatch(refreshAllFiles()).then(res);
                } else if (button === 2) { // Cancel
                    return rej();
                }

                // Should never be reached
                return rej();
            });
        });
    });
}
