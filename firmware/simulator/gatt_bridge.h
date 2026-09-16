#pragma once
#include <functional>
#include <string>

/**
 * Bridges firmware/lib/common/ble_provisioning.cpp's real NimBLE calls (via
 * stubs/NimBLEDevice.h) to worker/src/client/provision.ts's `?sim=<origin>`
 * transport over plain HTTP+SSE: GET /gatt/info, GET /gatt/events (SSE),
 * POST /gatt/config, POST /gatt/command - the exact same contract the
 * removed Node simulator's server.ts implemented and validated end-to-end,
 * now fronting the real ble_provisioning.cpp instead of a reimplementation.
 *
 * Runs its own background thread with its own POSIX listening socket (one
 * more thread per open connection - see gatt_bridge.cpp), mirroring how the
 * real NimBLE host stack runs independent of Arduino loop() too:
 * onWrite()-equivalent handlers fire directly from a connection thread, not
 * from anything main.cpp polls.
 */
namespace GattBridge {

// Starts/stops the background HTTP server. NimBLEDevice::init() calls
// start(); NimBLEDevice::deinit() calls stop(). Safe to call start() again
// after stop() (a fresh config-mode session gets a fresh listener).
void start(int port);
void stop();

// Wired up by the stub NimBLECharacteristic for the INFO/SCAN_RESULTS
// characteristics (see stubs/NimBLEDevice.h): setValue() buffers the current
// value, notify() broadcasts it to every connected /gatt/events SSE client.
void setInfoValue(const std::string &json);
void notifyInfo();
void setScanResultsValue(const std::string &json);
void notifyScanResults();

// Wired up once by BLEProvisioning::start() (via the stub
// NimBLECharacteristicCallbacks plumbing) - invoked from a connection thread
// when a real /gatt/config or /gatt/command POST arrives.
void setConfigWriteHandler(std::function<void(const std::string &json)> handler);
void setCommandHandler(std::function<void(const std::string &command)> handler);

}  // namespace GattBridge
