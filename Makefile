include .env

default: up

## up:	Start up containers.
.PHONY: up
up:
	@echo "Starting up containers for $(PROJECT_NAME)..."
	docker-compose pull
	docker-compose up -d --remove-orphans

.PHONY: upbuild
upbuild: base
	@echo "Starting up containers for $(PROJECT_NAME)..."
	docker-compose pull
	docker-compose up -d --remove-orphans --build

## down:	Stop containers.
.PHONY: down
down: stop

## start:	Start containers without updating.
.PHONY: start
start:
	@echo "Starting containers for $(PROJECT_NAME) from where you left off..."
	@docker-compose start

## stop:	Stop containers.
.PHONY: stop
stop:
	@echo "Stopping containers for $(PROJECT_NAME)..."
	@docker-compose stop

## restart:	Restarts containers
.PHONY: restart
restart:
	@make stop
	@make start

## prune:	Remove containers.
.PHONY: prune
prune:
	@echo "Removing containers for $(PROJECT_NAME)..."
	@docker-compose down -v $(filter-out $@,$(MAKECMDGOALS))

## ps:	List running containers.
.PHONY: ps
ps:
	@docker ps --filter name='$(PROJECT_NAME)*'


.PHONY: logs
logs:
	@exec docker-compose logs -f $(filter-out $@,$(MAKECMDGOALS))

# Allow passing extra words as "arguments" without make errors, e.g.:
#   make docs par1 par2
%:
	@:
