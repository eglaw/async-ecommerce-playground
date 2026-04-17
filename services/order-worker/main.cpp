#include <amqp.h>
#include <amqp_tcp_socket.h>

#include <nlohmann/json.hpp>

#include <cstdlib>
#include <cstring>
#include <iostream>
#include <string>
#include <thread>

namespace {

constexpr const char* kExchange = "orders.events";
constexpr const char* kQueueNew = "orders.new";
constexpr const char* kQueueStatus = "orders.status";
constexpr const char* kRouteNew = "order.new";
constexpr const char* kRouteStatus = "order.status";

void die_on_error(int x, const char* ctx) {
    if (x < 0) {
        std::cerr << ctx << ": " << amqp_error_string2(x) << "\n";
        std::exit(1);
    }
}

void die_on_amqp_error(amqp_rpc_reply_t r, const char* ctx) {
    switch (r.reply_type) {
        case AMQP_RESPONSE_NORMAL:
            return;
        case AMQP_RESPONSE_NONE:
            std::cerr << ctx << ": missing RPC reply\n";
            break;
        case AMQP_RESPONSE_LIBRARY_EXCEPTION:
            std::cerr << ctx << ": " << amqp_error_string2(r.library_error) << "\n";
            break;
        case AMQP_RESPONSE_SERVER_EXCEPTION:
            if (r.reply.id == AMQP_CHANNEL_CLOSE_METHOD) {
                auto* m = reinterpret_cast<amqp_channel_close_t*>(r.reply.decoded);
                std::cerr << ctx << ": channel close " << m->reply_code << " "
                          << std::string(reinterpret_cast<char*>(m->reply_text.bytes),
                                         m->reply_text.len)
                          << "\n";
            } else if (r.reply.id == AMQP_CONNECTION_CLOSE_METHOD) {
                auto* m = reinterpret_cast<amqp_connection_close_t*>(r.reply.decoded);
                std::cerr << ctx << ": connection close " << m->reply_code << " "
                          << std::string(reinterpret_cast<char*>(m->reply_text.bytes),
                                         m->reply_text.len)
                          << "\n";
            } else {
                std::cerr << ctx << ": unknown broker error\n";
            }
            break;
    }
    std::exit(1);
}

void declare_topology(amqp_connection_state_t conn, amqp_channel_t ch) {
    amqp_exchange_declare(conn, ch, amqp_cstring_bytes(kExchange),
                          amqp_cstring_bytes("topic"), 0, 1, 0, 0, amqp_empty_table);
    die_on_amqp_error(amqp_get_rpc_reply(conn), "exchange_declare");

    amqp_queue_declare(conn, ch, amqp_cstring_bytes(kQueueNew), 0, 1, 0, 0, amqp_empty_table);
    die_on_amqp_error(amqp_get_rpc_reply(conn), "queue_declare new");
    amqp_queue_bind(conn, ch, amqp_cstring_bytes(kQueueNew), amqp_cstring_bytes(kExchange),
                    amqp_cstring_bytes(kRouteNew), amqp_empty_table);
    die_on_amqp_error(amqp_get_rpc_reply(conn), "queue_bind new");

    amqp_queue_declare(conn, ch, amqp_cstring_bytes(kQueueStatus), 0, 1, 0, 0, amqp_empty_table);
    die_on_amqp_error(amqp_get_rpc_reply(conn), "queue_declare status");
    amqp_queue_bind(conn, ch, amqp_cstring_bytes(kQueueStatus), amqp_cstring_bytes(kExchange),
                    amqp_cstring_bytes(kRouteStatus), amqp_empty_table);
    die_on_amqp_error(amqp_get_rpc_reply(conn), "queue_bind status");
}

void publish_status(amqp_connection_state_t conn, amqp_channel_t ch, const std::string& order_id,
                    const std::string& status, const std::string& detail) {
    nlohmann::json j = {{"order_id", order_id}, {"status", status}, {"detail", detail}};
    const std::string body = j.dump();

    amqp_basic_properties_t props{};
    props._flags = AMQP_BASIC_CONTENT_TYPE_FLAG | AMQP_BASIC_DELIVERY_MODE_FLAG;
    props.content_type = amqp_cstring_bytes("application/json");
    props.delivery_mode = 2;

    std::clog << "[cpp-worker] publish order.status order_id=" << order_id << " status=" << status
              << " bytes=" << body.size() << "\n";
    die_on_error(amqp_basic_publish(conn, ch, amqp_cstring_bytes(kExchange),
                                    amqp_cstring_bytes(kRouteStatus), 0, 0, &props,
                                    amqp_cstring_bytes(body.c_str())),
                 "basic_publish");
}

}  // namespace

int main() {
    const char* url = std::getenv("AMQP_URL");
    if (!url || !*url) {
        std::cerr << "AMQP_URL is required\n";
        return 1;
    }

    amqp_connection_info ci{};
    char url_buf[256];
    std::strncpy(url_buf, url, sizeof(url_buf) - 1);
    url_buf[sizeof(url_buf) - 1] = '\0';
    if (amqp_parse_url(url_buf, &ci) != AMQP_STATUS_OK) {
        std::cerr << "[cpp-worker] invalid AMQP_URL\n";
        return 1;
    }

    std::clog << "[cpp-worker] connecting host=" << (ci.host ? ci.host : "?")
              << " port=" << ci.port << "\n";

    amqp_connection_state_t conn = amqp_new_connection();
    amqp_socket_t* sock = amqp_tcp_socket_new(conn);
    if (!sock) {
        std::cerr << "tcp_socket_new failed\n";
        return 1;
    }
    die_on_error(amqp_socket_open(sock, ci.host, ci.port), "socket_open");

    const char* vhost = (ci.vhost && ci.vhost[0]) ? ci.vhost : "/";
    die_on_amqp_error(amqp_login(conn, vhost, 0, 131072, 0, AMQP_SASL_METHOD_PLAIN,
                                 ci.user, ci.password),
                      "login");

    constexpr amqp_channel_t kConsumeCh = 1;
    constexpr amqp_channel_t kPublishCh = 2;
    amqp_channel_open(conn, kConsumeCh);
    die_on_amqp_error(amqp_get_rpc_reply(conn), "channel_open 1");
    amqp_channel_open(conn, kPublishCh);
    die_on_amqp_error(amqp_get_rpc_reply(conn), "channel_open 2");

    declare_topology(conn, kConsumeCh);
    declare_topology(conn, kPublishCh);

    amqp_basic_qos(conn, kConsumeCh, 0, 1, 0);
    die_on_amqp_error(amqp_get_rpc_reply(conn), "basic_qos");

    amqp_bytes_t tag = amqp_cstring_bytes("cpp-worker");
    amqp_basic_consume(conn, kConsumeCh, amqp_cstring_bytes(kQueueNew), tag, 0, 0, 0,
                       amqp_empty_table);
    die_on_amqp_error(amqp_get_rpc_reply(conn), "basic_consume");

    std::clog << "[cpp-worker] ready; consuming queue=" << kQueueNew << " publish_route=" << kRouteStatus
              << "\n";

    while (true) {
        amqp_maybe_release_buffers(conn);
        amqp_envelope_t envelope;
        struct timeval timeout;
        timeout.tv_sec = 30;
        timeout.tv_usec = 0;

        amqp_rpc_reply_t res = amqp_consume_message(conn, &envelope, &timeout, 0);
        if (res.reply_type == AMQP_RESPONSE_LIBRARY_EXCEPTION &&
            res.library_error == AMQP_STATUS_TIMEOUT) {
            continue;
        }
        die_on_amqp_error(res, "consume_message");

        std::string body(reinterpret_cast<char*>(envelope.message.body.bytes),
                         envelope.message.body.len);

        std::clog << "[cpp-worker] received order.new delivery_tag=" << envelope.delivery_tag
                  << " body_bytes=" << body.size() << "\n";

        try {
            auto j = nlohmann::json::parse(body);
            std::string order_id = j.at("order_id").get<std::string>();

            std::clog << "[cpp-worker] parsed order_id=" << order_id << " simulating work (1s)\n";
            std::this_thread::sleep_for(std::chrono::seconds(1));

            publish_status(conn, kPublishCh, order_id, "processing", "picked for fulfillment");
            std::clog << "[cpp-worker] simulating fulfillment delay (2s)\n";
            std::this_thread::sleep_for(std::chrono::seconds(2));
            publish_status(conn, kPublishCh, order_id, "shipped", "left warehouse");
            std::clog << "[cpp-worker] finished pipeline for order_id=" << order_id << "\n";
        } catch (const std::exception& e) {
            std::cerr << "[cpp-worker] bad message: " << e.what() << "\n";
        }

        die_on_error(amqp_basic_ack(conn, kConsumeCh, envelope.delivery_tag, 0), "basic_ack");
        std::clog << "[cpp-worker] ack delivery_tag=" << envelope.delivery_tag << "\n";
        amqp_destroy_envelope(&envelope);
    }
}
