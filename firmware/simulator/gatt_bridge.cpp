#include "gatt_bridge.h"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <thread>
#include <vector>

namespace GattBridge {
namespace {

std::mutex g_mutex;
int g_listenFd = -1;
std::thread g_acceptThread;
bool g_running = false;

std::string g_infoJson = "{}";
std::string g_scanResultsJson = "[]";
std::vector<int> g_sseClients;

std::function<void(const std::string &)> g_configWriteHandler;
std::function<void(const std::string &)> g_commandHandler;

struct HttpRequest {
    std::string method;
    std::string path;
    std::string body;
};

// Reads one HTTP/1.1 request (headers + Content-Length body, if any) off a
// blocking socket. Good enough for the small, trusted, local-only requests
// this server ever receives (the real /provision page's fetch() calls) -
// not a general-purpose HTTP parser.
bool readRequest(int fd, HttpRequest &out) {
    std::string buf;
    char chunk[4096];
    size_t headerEnd = std::string::npos;
    while (headerEnd == std::string::npos) {
        ssize_t n = recv(fd, chunk, sizeof(chunk), 0);
        if (n <= 0) return false;
        buf.append(chunk, (size_t)n);
        headerEnd = buf.find("\r\n\r\n");
        if (buf.size() > 65536) return false;  // sanity cap
    }

    std::string headerBlock = buf.substr(0, headerEnd);
    std::string rest = buf.substr(headerEnd + 4);

    size_t lineEnd = headerBlock.find("\r\n");
    std::string requestLine = headerBlock.substr(0, lineEnd);
    size_t sp1 = requestLine.find(' ');
    size_t sp2 = requestLine.find(' ', sp1 + 1);
    if (sp1 == std::string::npos || sp2 == std::string::npos) return false;
    out.method = requestLine.substr(0, sp1);
    out.path = requestLine.substr(sp1 + 1, sp2 - sp1 - 1);

    size_t contentLength = 0;
    size_t pos = lineEnd + 2;
    while (pos < headerBlock.size()) {
        size_t next = headerBlock.find("\r\n", pos);
        if (next == std::string::npos) next = headerBlock.size();
        std::string line = headerBlock.substr(pos, next - pos);
        std::string lower = line;
        for (auto &c : lower) c = (char)tolower((unsigned char)c);
        if (lower.rfind("content-length:", 0) == 0) {
            contentLength = (size_t)strtoul(line.c_str() + 15, nullptr, 10);
        }
        pos = next + 2;
    }

    while (rest.size() < contentLength) {
        ssize_t n = recv(fd, chunk, sizeof(chunk), 0);
        if (n <= 0) break;
        rest.append(chunk, (size_t)n);
    }
    out.body = rest.substr(0, contentLength);
    return true;
}

void sendResponse(int fd, int status, const char *contentType, const std::string &body) {
    const char *statusText = status == 200 ? "OK" : status == 204 ? "No Content" : status == 400 ? "Bad Request"
                              : status == 404                     ? "Not Found"
                                                                   : "Error";
    char header[512];
    int n = snprintf(header, sizeof(header),
                      "HTTP/1.1 %d %s\r\n"
                      "Access-Control-Allow-Origin: *\r\n"
                      "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
                      "Access-Control-Allow-Headers: Content-Type\r\n"
                      "Content-Type: %s\r\n"
                      "Content-Length: %zu\r\n"
                      "Connection: close\r\n\r\n",
                      status, statusText, contentType, body.size());
    send(fd, header, (size_t)n, 0);
    if (!body.empty()) send(fd, body.data(), body.size(), 0);
}

// Writes one SSE event as a single HTTP chunk (see startSseStream()).
void writeSseEvent(int fd, const std::string &event, const std::string &data) {
    std::string payload = "event: " + event + "\ndata: " + data + "\n\n";
    char sizeLine[32];
    int n = snprintf(sizeLine, sizeof(sizeLine), "%zx\r\n", payload.size());
    if (send(fd, sizeLine, (size_t)n, 0) < 0) return;
    if (send(fd, payload.data(), payload.size(), 0) < 0) return;
    send(fd, "\r\n", 2, 0);
}

void broadcast(const std::string &event, const std::string &data) {
    std::lock_guard<std::mutex> lock(g_mutex);
    for (int fd : g_sseClients) writeSseEvent(fd, event, data);
}

// Registers this connection as an SSE client, sends chunked-encoding
// headers, then blocks reading (the client - EventSource - never sends
// anything after the initial request) until the socket closes, which is
// this server's only signal that the browser navigated away/disconnected.
void handleSseConnection(int fd) {
    const char *headers =
        "HTTP/1.1 200 OK\r\n"
        "Access-Control-Allow-Origin: *\r\n"
        "Content-Type: text/event-stream\r\n"
        "Cache-Control: no-cache\r\n"
        "Transfer-Encoding: chunked\r\n"
        "Connection: keep-alive\r\n\r\n";
    send(fd, headers, strlen(headers), 0);

    {
        std::lock_guard<std::mutex> lock(g_mutex);
        g_sseClients.push_back(fd);
    }

    char buf[256];
    while (true) {
        ssize_t n = recv(fd, buf, sizeof(buf), 0);
        if (n <= 0) break;
    }

    std::lock_guard<std::mutex> lock(g_mutex);
    g_sseClients.erase(std::remove(g_sseClients.begin(), g_sseClients.end(), fd), g_sseClients.end());
    close(fd);
}

void handleConnection(int fd) {
    HttpRequest req;
    if (!readRequest(fd, req)) {
        close(fd);
        return;
    }

    if (req.method == "OPTIONS") {
        sendResponse(fd, 204, "text/plain", "");
        close(fd);
        return;
    }

    if (req.method == "GET" && req.path == "/gatt/info") {
        std::string body;
        {
            std::lock_guard<std::mutex> lock(g_mutex);
            body = g_infoJson;
        }
        sendResponse(fd, 200, "application/json", body);
        close(fd);
        return;
    }

    if (req.method == "GET" && req.path == "/gatt/events") {
        handleSseConnection(fd);  // takes ownership of fd, closes it itself
        return;
    }

    if (req.method == "POST" && req.path == "/gatt/config") {
        std::function<void(const std::string &)> handler;
        {
            std::lock_guard<std::mutex> lock(g_mutex);
            handler = g_configWriteHandler;
        }
        if (handler) handler(req.body);
        sendResponse(fd, 204, "text/plain", "");
        close(fd);
        return;
    }

    if (req.method == "POST" && req.path == "/gatt/command") {
        std::function<void(const std::string &)> handler;
        {
            std::lock_guard<std::mutex> lock(g_mutex);
            handler = g_commandHandler;
        }
        if (handler) handler(req.body);
        sendResponse(fd, 204, "text/plain", "");
        close(fd);
        return;
    }

    sendResponse(fd, 404, "text/plain", "Not found");
    close(fd);
}

void acceptLoop(int listenFd) {
    while (true) {
        sockaddr_in clientAddr{};
        socklen_t len = sizeof(clientAddr);
        int clientFd = accept(listenFd, (sockaddr *)&clientAddr, &len);
        if (clientFd < 0) {
            if (!g_running) return;  // listener was closed by stop()
            continue;
        }
        std::thread(handleConnection, clientFd).detach();
    }
}

}  // namespace

void start(int port) {
    std::lock_guard<std::mutex> lock(g_mutex);
    if (g_running) return;

    g_listenFd = socket(AF_INET, SOCK_STREAM, 0);
    int opt = 1;
    setsockopt(g_listenFd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port = htons((uint16_t)port);

    if (bind(g_listenFd, (sockaddr *)&addr, sizeof(addr)) < 0) {
        perror("GattBridge: bind failed");
        close(g_listenFd);
        g_listenFd = -1;
        return;
    }
    listen(g_listenFd, 16);

    g_running = true;
    g_acceptThread = std::thread(acceptLoop, g_listenFd);
    printf("GattBridge: listening on http://localhost:%d (serves /gatt/* for the /provision page's ?sim= transport)\n", port);
}

void stop() {
    int fdToClose = -1;
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        if (!g_running) return;
        g_running = false;
        fdToClose = g_listenFd;
        g_listenFd = -1;
    }
    if (fdToClose >= 0) shutdown(fdToClose, SHUT_RDWR), close(fdToClose);
    if (g_acceptThread.joinable()) g_acceptThread.join();
}

void setInfoValue(const std::string &json) {
    std::lock_guard<std::mutex> lock(g_mutex);
    g_infoJson = json;
}
void notifyInfo() {
    std::string json;
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        json = g_infoJson;
    }
    broadcast("info", json);
}

void setScanResultsValue(const std::string &json) {
    std::lock_guard<std::mutex> lock(g_mutex);
    g_scanResultsJson = json;
}
void notifyScanResults() {
    std::string json;
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        json = g_scanResultsJson;
    }
    broadcast("scan_results", json);
}

void setConfigWriteHandler(std::function<void(const std::string &)> handler) {
    std::lock_guard<std::mutex> lock(g_mutex);
    g_configWriteHandler = std::move(handler);
}
void setCommandHandler(std::function<void(const std::string &)> handler) {
    std::lock_guard<std::mutex> lock(g_mutex);
    g_commandHandler = std::move(handler);
}

}  // namespace GattBridge
