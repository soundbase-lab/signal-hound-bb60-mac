// bb60-worker — the only code in this plugin that touches Signal Hound's
// libbb_api. One process per open device, speaking JSON lines over stdio (see
// ../protocol.md), so the driver can SIGKILL it when a USB call wedges and the
// plugin process itself never blocks.
//
//   bb60-worker --lib <path> --list   print one JSON line of attached devices
//   bb60-worker --lib <path>          serve requests on stdin until it closes
//   bb60-worker --mock                the same, against a synthetic device (no
//                                     library, no hardware, no USB I/O) — what
//                                     the integration test drives
//
// Signal Hound's library is not part of this plugin and is not linked here.
// The user installs it from Signal Hound (see README), the driver finds it,
// and it is loaded at run time from the path given by --lib. So this file
// builds with no vendor SDK present, and a Mac without the library gets a
// worker that starts and says exactly what is missing.
//
// Two things about the macOS build of the vendor library shape this file:
//
//   - bbCloseDevice() traps (brk #1) after a successful open, in 5.0.11. It is
//     never called: a device is released by bbAbort() and process exit, which
//     is why "close" in this plugin means "the worker goes away".
//   - The device chooses its own bin spacing from the RBW (tens of thousands
//     of bins for a UHF sweep). The host asks for a few hundred points, so
//     every sweep is reduced here, onto the grid the host asked for, before it
//     crosses the pipe.

#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include <dlfcn.h>
#include <poll.h>
#include <unistd.h>

using Clock = std::chrono::steady_clock;

namespace {

// -- the vendor API, as far as this worker uses it ------------------------------
//
// Names, signatures and values are Signal Hound's (bb_api.h, API 5.0.x); they
// are restated here so that building needs nothing of theirs.

typedef int bbStatus;
const bbStatus bbNoError = 0;
const bbStatus bbDeviceNotOpenErr = -1;
const bbStatus bbDeviceInvalidErr = -9;
const bbStatus bbPacketFramingErr = -13;
const bbStatus bbDeviceConnectionErr = -14;
const bbStatus bbUSBTimeoutErr = -15;
const bbStatus bbLibusbError = -18;
const bbStatus bbBandwidthErr = -106;

const int BB_MAX_DEVICES = 8;
const int BB_DEVICE_BB60A = 1, BB_DEVICE_BB60C = 2, BB_DEVICE_BB60D = 3;
const double BB_MIN_FREQ = 9.0e3, BB_MAX_FREQ = 6.4e9, BB_MIN_SPAN = 20.0;
const double BB_MAX_REFERENCE = 20.0;
const int BB_AUTO_ATTEN = -1, BB_AUTO_GAIN = -1;
const uint32_t BB_SWEEPING = 0;
const uint32_t BB_NO_SPUR_REJECT = 0;
const uint32_t BB_LOG_SCALE = 0;
const uint32_t BB_RBW_SHAPE_FLATTOP = 1;
const uint32_t BB_MIN_AND_MAX = 0, BB_AVERAGE = 1;
const uint32_t BB_POWER = 2;

#define BB_FUNCTIONS(X)                                                        \
    X(bbStatus, bbGetSerialNumberList2, (int *, int *, int *))                 \
    X(bbStatus, bbOpenDevice, (int *))                                         \
    X(bbStatus, bbOpenDeviceBySerialNumber, (int *, int))                      \
    X(bbStatus, bbGetSerialNumber, (int, uint32_t *))                          \
    X(bbStatus, bbGetDeviceType, (int, int *))                                 \
    X(bbStatus, bbGetFirmwareVersion, (int, int *))                            \
    X(bbStatus, bbGetDeviceDiagnostics, (int, float *, float *, float *))      \
    X(bbStatus, bbConfigureRefLevel, (int, double))                            \
    X(bbStatus, bbConfigureGainAtten, (int, int, int))                         \
    X(bbStatus, bbConfigureCenterSpan, (int, double, double))                  \
    X(bbStatus, bbConfigureSweepCoupling,                                      \
      (int, double, double, double, uint32_t, uint32_t))                       \
    X(bbStatus, bbConfigureAcquisition, (int, uint32_t, uint32_t))             \
    X(bbStatus, bbConfigureProcUnits, (int, uint32_t))                         \
    X(bbStatus, bbInitiate, (int, uint32_t, uint32_t))                         \
    X(bbStatus, bbAbort, (int))                                                \
    X(bbStatus, bbQueryTraceInfo, (int, uint32_t *, double *, double *))       \
    X(bbStatus, bbFetchTrace_32f, (int, int, float *, float *))                \
    X(const char *, bbGetAPIVersion, ())                                       \
    X(const char *, bbGetErrorString, (bbStatus))

#define X(ret, name, args) ret (*name) args = nullptr;
BB_FUNCTIONS(X)
#undef X

// Empty when the library is loaded; otherwise why it is not.
std::string libraryError = "no library path was given (--lib)";

void loadLibrary(const char *path) {
    void *lib = dlopen(path, RTLD_NOW | RTLD_LOCAL);
    if (!lib) {
        libraryError = dlerror();
        return;
    }
#define X(ret, name, args)                                                     \
    name = (ret (*) args) dlsym(lib, #name);                                   \
    if (!name) {                                                               \
        libraryError = std::string(path) + " has no " #name;                   \
        return;                                                                \
    }
    BB_FUNCTIONS(X)
#undef X
    libraryError.clear();
}

const double MIN_RBW_HZ = 1.0e3;  // the ARM builds refuse anything narrower
const double MAX_RBW_HZ = 10.0e6;
const int MOCK_SERIAL = 60000001;
const double DIAG_INTERVAL_S = 2.0;

struct SweepConfig {
    double startHz = 470.0e6;
    double stopHz = 616.0e6;
    int pointCount = 451;
    double rbwHz = 100.0e3;
    double refLevelDbm = -20.0;
    bool average = false;  // detector: false = peak
};

// The device's own trace geometry, as bbQueryTraceInfo reports it.
struct DeviceTrace {
    uint32_t bins = 0;
    double binHz = 0;
    double startHz = 0;
};

bool mock = false;
int handle = -1;
bool configured = false;
bool sweeping = false;
long generation = 0;
SweepConfig config;
DeviceTrace device;
std::vector<float> traceMin, traceMax, reduced;
Clock::time_point lastDiag;
unsigned long mockSweeps = 0;

// -- output -------------------------------------------------------------------

void emit(const std::string &line) {
    fwrite(line.data(), 1, line.size(), stdout);
    fputc('\n', stdout);
    fflush(stdout);
}

std::string quoted(const char *s) {
    std::string out = "\"";
    for (; s && *s; ++s) {
        if (*s == '"' || *s == '\\') out += '\\';
        if (*s == '\n') { out += "\\n"; continue; }
        out += *s;
    }
    return out + "\"";
}

std::string num(double v) {
    char buf[40];
    snprintf(buf, sizeof buf, "%.17g", v);
    return buf;
}

void replyOk(long id, const std::string &fields = "") {
    emit("{\"id\":" + std::to_string(id) + ",\"ok\":true" +
         (fields.empty() ? "" : "," + fields) + "}");
}

void replyError(long id, const std::string &message, int status = 0) {
    emit("{\"id\":" + std::to_string(id) + ",\"ok\":false,\"status\":" +
         std::to_string(status) + ",\"error\":" + quoted(message.c_str()) + "}");
}

// The transport is gone. Say so and leave; the driver turns this into onFatal.
[[noreturn]] void fatal(const std::string &message, int status) {
    emit("{\"ev\":\"fatal\",\"status\":" + std::to_string(status) +
         ",\"error\":" + quoted(message.c_str()) + "}");
    _exit(2);
}

[[noreturn]] void leave() {
    if (!mock && handle >= 0) bbAbort(handle);
    // not bbCloseDevice: see the note at the top of this file
    _exit(0);
}

// -- input: flat JSON objects written by our own driver -------------------------

bool findValue(const std::string &line, const char *key, size_t &pos) {
    const std::string needle = std::string("\"") + key + "\":";
    pos = line.find(needle);
    if (pos == std::string::npos) return false;
    pos += needle.size();
    while (pos < line.size() && line[pos] == ' ') ++pos;
    return pos < line.size();
}

bool getNumber(const std::string &line, const char *key, double &out) {
    size_t pos;
    if (!findValue(line, key, pos)) return false;
    char *end = nullptr;
    const double v = strtod(line.c_str() + pos, &end);
    if (end == line.c_str() + pos || !std::isfinite(v)) return false;
    out = v;
    return true;
}

bool getString(const std::string &line, const char *key, std::string &out) {
    size_t pos;
    if (!findValue(line, key, pos) || line[pos] != '"') return false;
    const size_t end = line.find('"', pos + 1);
    if (end == std::string::npos) return false;
    out = line.substr(pos + 1, end - pos - 1);
    return true;
}

// -- the device -----------------------------------------------------------------

bool isConnectionError(bbStatus s) {
    return s == bbDeviceConnectionErr || s == bbUSBTimeoutErr ||
           s == bbPacketFramingErr || s == bbDeviceNotOpenErr ||
           s == bbDeviceInvalidErr || s == bbLibusbError;
}

const char *modelName(int type) {
    switch (type) {
        case BB_DEVICE_BB60A: return "BB60A";
        case BB_DEVICE_BB60C: return "BB60C";
        case BB_DEVICE_BB60D: return "BB60D";
        default: return "BB60";
    }
}

std::string listJson() {
    int serials[BB_MAX_DEVICES] = {0}, types[BB_MAX_DEVICES] = {0}, count = 0;
    if (mock) {
        serials[0] = MOCK_SERIAL;
        types[0] = BB_DEVICE_BB60C;
        count = 1;
    } else if (!libraryError.empty()) {
        return "\"devices\":[],\"libraryError\":" + quoted(libraryError.c_str());
    } else {
        const bbStatus s = bbGetSerialNumberList2(serials, types, &count);
        if (s < bbNoError) count = 0;
    }
    std::string out = "\"devices\":[";
    for (int i = 0; i < count; ++i) {
        if (i) out += ",";
        out += "{\"serial\":" + std::to_string(serials[i]) + ",\"type\":" +
               std::to_string(types[i]) + ",\"model\":" +
               quoted(modelName(types[i])) + "}";
    }
    return out + "]";
}

// 1-3-10 steps, for backing off an RBW the device will not take at this span
double nextRbw(double rbw) {
    const double decade = pow(10.0, floor(log10(rbw) + 1e-9));
    const double mantissa = rbw / decade;
    return mantissa < 2.9 ? 3.0 * decade : 10.0 * decade;
}

double mockNoiseFloor(double rbw) { return -150.0 + 10.0 * log10(rbw); }

// A device-shaped trace: its own bin spacing, a noise floor that follows the
// RBW, and two carriers far narrower than a host point — which is the case the
// reduction below exists for. A transient lands on one sweep in seven, so
// max-hold is exercised too.
void mockFetch() {
    ++mockSweeps;
    const double floorDbm = mockNoiseFloor(config.rbwHz);
    const double carriers[][2] = {{518.1e6, -45.0}, {566.3e6, -60.0}};
    const bool transient = mockSweeps % 7 == 0;
    for (uint32_t i = 0; i < device.bins; ++i) {
        const double f = device.startHz + i * device.binHz;
        double amp = floorDbm + (rand() / (double)RAND_MAX) * 4.0 - 2.0;
        for (const auto &c : carriers) {
            const double off = fabs(f - c[0]) / config.rbwHz;
            if (off < 3.0) amp = fmax(amp, c[1] - 12.0 * off * off);
        }
        if (transient) {
            const double off = fabs(f - 543.0e6) / config.rbwHz;
            if (off < 3.0) amp = fmax(amp, -40.0 - 12.0 * off * off);
        }
        traceMax[i] = (float)amp;
    }
    usleep(15000);
}

// Returns a bbStatus: negative is an error, positive a warning.
int fetchSweep() {
    if (mock) {
        mockFetch();
        return bbNoError;
    }
    return bbFetchTrace_32f(handle, (int)device.bins, traceMin.data(),
                            traceMax.data());
}

// Put the device's trace onto the host's grid: point i sits at
// startHz + i * step, and takes every device bin within half a step of it.
// Peak keeps the strongest bin, so a carrier narrower than a point is never
// lost; average takes the mean power. A point with no bin of its own (more
// points asked for than the device produced) takes the nearest bin.
void reduce() {
    const int points = config.pointCount;
    const double step = (config.stopHz - config.startHz) / (points - 1);
    const long last = (long)device.bins - 1;
    reduced.resize(points);
    for (int i = 0; i < points; ++i) {
        const double f = config.startHz + i * step;
        long lo = (long)ceil((f - step / 2 - device.startHz) / device.binHz);
        long hi = (long)floor((f + step / 2 - device.startHz) / device.binHz);
        if (hi < lo) lo = hi = lround((f - device.startHz) / device.binHz);
        lo = lo < 0 ? 0 : (lo > last ? last : lo);
        hi = hi < 0 ? 0 : (hi > last ? last : hi);
        if (config.average) {
            double sum = 0;
            for (long k = lo; k <= hi; ++k) sum += pow(10.0, traceMax[k] / 10.0);
            reduced[i] = (float)(10.0 * log10(sum / (double)(hi - lo + 1)));
        } else {
            float peak = traceMax[lo];
            for (long k = lo + 1; k <= hi; ++k)
                if (traceMax[k] > peak) peak = traceMax[k];
            reduced[i] = peak;
        }
    }
}

void handleOpen(long id, const std::string &line) {
    if (handle >= 0) return replyOk(id);
    double serial = 0;
    const bool bySerial = getNumber(line, "serial", serial) && serial > 0;
    int type = BB_DEVICE_BB60C, firmware = 0;
    uint32_t actualSerial = MOCK_SERIAL;
    if (mock) {
        handle = 0;
    } else if (!libraryError.empty()) {
        return emit("{\"id\":" + std::to_string(id) +
                    ",\"ok\":false,\"status\":0,\"error\":\"library\",\"libraryError\":" +
                    quoted(libraryError.c_str()) + "}");
    } else {
        int h = -1;
        const bbStatus s = bySerial
            ? bbOpenDeviceBySerialNumber(&h, (int)serial)
            : bbOpenDevice(&h);
        if (s < bbNoError) {
            return replyError(id, bbGetErrorString(s), s);
        }
        handle = h;
        bbGetSerialNumber(handle, &actualSerial);
        bbGetDeviceType(handle, &type);
        bbGetFirmwareVersion(handle, &firmware);
    }
    replyOk(id, "\"serial\":" + std::to_string(actualSerial) + ",\"type\":" +
                    std::to_string(type) + ",\"model\":" +
                    quoted(modelName(type)) + ",\"firmware\":" +
                    std::to_string(firmware) + ",\"apiVersion\":" +
                    quoted(mock ? "mock" : bbGetAPIVersion()));
}

void handleConfig(long id, const std::string &line) {
    if (handle < 0) return replyError(id, "device is not open");
    SweepConfig next = config;
    double v;
    std::string detector;
    if (getNumber(line, "startHz", v)) next.startHz = v;
    if (getNumber(line, "stopHz", v)) next.stopHz = v;
    if (getNumber(line, "pointCount", v)) next.pointCount = (int)lround(v);
    if (getNumber(line, "rbwHz", v)) next.rbwHz = v;
    if (getNumber(line, "refLevelDbm", v)) next.refLevelDbm = v;
    if (getString(line, "detector", detector)) next.average = detector == "average";

    // the adapter clamps before it asks; this is the backstop
    next.startHz = fmax(next.startHz, BB_MIN_FREQ);
    next.stopHz = fmin(next.stopHz, BB_MAX_FREQ);
    if (next.stopHz - next.startHz < BB_MIN_SPAN) next.stopHz = next.startHz + BB_MIN_SPAN;
    if (next.pointCount < 2) next.pointCount = 2;
    next.rbwHz = fmin(fmax(next.rbwHz, MIN_RBW_HZ), MAX_RBW_HZ);
    next.refLevelDbm = fmin(next.refLevelDbm, BB_MAX_REFERENCE);

    const double span = next.stopHz - next.startHz;
    DeviceTrace info;
    if (mock) {
        info.binHz = next.rbwHz / 4.0;
        info.startHz = next.startHz - info.binHz;
        info.bins = (uint32_t)ceil(span / info.binHz) + 3;
    } else {
        bbStatus s = bbNoError;
        // "RBWs can be set to arbitrary values but may be limited by mode of
        // operation and span": widen until the device takes it rather than
        // refuse a sweep the user can still use.
        for (;;) {
            bbConfigureRefLevel(handle, next.refLevelDbm);
            bbConfigureGainAtten(handle, BB_AUTO_GAIN, BB_AUTO_ATTEN);
            bbConfigureCenterSpan(handle, next.startHz + span / 2, span);
            bbConfigureSweepCoupling(handle, next.rbwHz, next.rbwHz, 0.001,
                                     BB_RBW_SHAPE_FLATTOP, BB_NO_SPUR_REJECT);
            bbConfigureAcquisition(handle, next.average ? BB_AVERAGE : BB_MIN_AND_MAX,
                                   BB_LOG_SCALE);
            bbConfigureProcUnits(handle, BB_POWER);
            s = bbInitiate(handle, BB_SWEEPING, 0);
            if (s == bbBandwidthErr && next.rbwHz < MAX_RBW_HZ) {
                next.rbwHz = fmin(nextRbw(next.rbwHz), MAX_RBW_HZ);
                continue;
            }
            break;
        }
        if (s < bbNoError) {
            configured = false;
            sweeping = false;
            if (isConnectionError(s)) fatal(bbGetErrorString(s), s);
            return replyError(id, bbGetErrorString(s), s);
        }
        bbQueryTraceInfo(handle, &info.bins, &info.binHz, &info.startHz);
        if (info.bins == 0 || !(info.binHz > 0)) {
            configured = false;
            sweeping = false;
            return replyError(id, "the device reported an empty sweep");
        }
    }

    config = next;
    device = info;
    traceMin.assign(device.bins, 0.0f);
    traceMax.assign(device.bins, 0.0f);
    configured = true;
    ++generation;

    // One sweep, timed and thrown away: it proves the configuration really
    // sweeps, and tells the host how long to wait before calling us stalled.
    const auto t0 = Clock::now();
    const int s = fetchSweep();
    const double sweepMs =
        std::chrono::duration<double, std::milli>(Clock::now() - t0).count();
    if (s < bbNoError) {
        configured = false;
        sweeping = false;
        if (isConnectionError((bbStatus)s)) fatal(bbGetErrorString((bbStatus)s), s);
        return replyError(id, bbGetErrorString((bbStatus)s), s);
    }

    replyOk(id, "\"gen\":" + std::to_string(generation) +
                    ",\"startHz\":" + num(config.startHz) +
                    ",\"stopHz\":" + num(config.stopHz) +
                    ",\"pointCount\":" + std::to_string(config.pointCount) +
                    ",\"rbwHz\":" + num(config.rbwHz) +
                    ",\"refLevelDbm\":" + num(config.refLevelDbm) +
                    ",\"detector\":" + (config.average ? "\"average\"" : "\"peak\"") +
                    ",\"deviceBins\":" + std::to_string(device.bins) +
                    ",\"binHz\":" + num(device.binHz) +
                    ",\"sweepMs\":" + num(sweepMs));
}

void handleLine(const std::string &line) {
    double idValue = 0;
    getNumber(line, "id", idValue);
    const long id = (long)idValue;
    std::string op;
    if (!getString(line, "op", op)) return replyError(id, "request has no op");

    if (op == "list") return replyOk(id, listJson());
    if (op == "open") return handleOpen(id, line);
    if (op == "config") return handleConfig(id, line);
    if (op == "start") {
        if (!configured) return replyError(id, "configure the sweep before starting it");
        sweeping = true;
        return replyOk(id);
    }
    if (op == "stop") {
        sweeping = false;
        return replyOk(id);
    }
    if (op == "quit") {
        replyOk(id);
        leave();
    }
    replyError(id, "unknown op " + op);
}

void emitDiagnostics() {
    float tempC = 30.0f, volts = 4.9f, amps = 0;
    if (!mock && bbGetDeviceDiagnostics(handle, &tempC, &volts, &amps) < bbNoError) return;
    char buf[96];
    snprintf(buf, sizeof buf, "{\"ev\":\"diag\",\"tempC\":%.1f,\"usbVolts\":%.2f}",
             tempC, volts);
    emit(buf);
}

void sweepOnce() {
    const int s = fetchSweep();
    if (s < bbNoError) {
        if (isConnectionError((bbStatus)s)) fatal(bbGetErrorString((bbStatus)s), s);
        sweeping = false;
        emit("{\"ev\":\"error\",\"status\":" + std::to_string(s) + ",\"error\":" +
             quoted(bbGetErrorString((bbStatus)s)) + "}");
        return;
    }
    reduce();
    std::string out;
    out.reserve(reduced.size() * 7 + 64);
    out += "{\"ev\":\"trace\",\"gen\":" + std::to_string(generation) +
           ",\"status\":" + std::to_string(s) + ",\"amps\":[";
    char buf[16];
    for (size_t i = 0; i < reduced.size(); ++i) {
        const float a = std::isfinite(reduced[i]) ? reduced[i] : -200.0f;
        snprintf(buf, sizeof buf, i ? ",%.1f" : "%.1f", a);
        out += buf;
    }
    out += "]}";
    emit(out);

    if (std::chrono::duration<double>(Clock::now() - lastDiag).count() >= DIAG_INTERVAL_S) {
        lastDiag = Clock::now();
        emitDiagnostics();
    }
}

}  // namespace

int main(int argc, char **argv) {
    bool listOnly = false;
    const char *libraryPath = nullptr;
    for (int i = 1; i < argc; ++i) {
        if (!strcmp(argv[i], "--mock")) mock = true;
        if (!strcmp(argv[i], "--list")) listOnly = true;
        if (!strcmp(argv[i], "--lib") && i + 1 < argc) libraryPath = argv[++i];
    }
    if (!mock && libraryPath) loadLibrary(libraryPath);

    if (listOnly) {
        emit("{" + listJson() + "}");
        _exit(0);
    }

    lastDiag = Clock::now();
    std::string pending;
    char chunk[4096];
    for (;;) {
        // block for a request when idle; between sweeps, only look
        struct pollfd pfd = {STDIN_FILENO, POLLIN, 0};
        const int ready = poll(&pfd, 1, sweeping ? 0 : -1);
        if (ready > 0) {
            const ssize_t n = read(STDIN_FILENO, chunk, sizeof chunk);
            if (n <= 0) leave();  // the driver went away: so do we
            pending.append(chunk, (size_t)n);
            size_t eol;
            while ((eol = pending.find('\n')) != std::string::npos) {
                const std::string line = pending.substr(0, eol);
                pending.erase(0, eol + 1);
                if (!line.empty()) handleLine(line);
            }
        }
        if (sweeping) sweepOnce();
    }
}
