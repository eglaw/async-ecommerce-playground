cmake_minimum_required(VERSION 3.16)
project(order_worker CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(nlohmann_json 3.2.0 REQUIRED)
find_package(PkgConfig REQUIRED)
pkg_check_modules(RABBITMQ REQUIRED IMPORTED_TARGET librabbitmq)

add_executable(order-worker main.cpp)
target_link_libraries(order-worker PRIVATE nlohmann_json::nlohmann_json PkgConfig::RABBITMQ)
