"""The single shared state of one server process: storage, drones, GCS links, alerts and video."""
from . import auth
from .alerts import AlertEngine
from .analysis import Analyser
from .fleet import FleetManager
from .store import Store
from .vehicle import Hub
from .video import VideoMonitor

store = Store()
auth.bootstrap(store)
hub = Hub(store)
fleet = FleetManager(store, hub)
hub.fleet = fleet
video = VideoMonitor(fleet)
alerts = AlertEngine(store, hub, fleet, video)
hub.alerts = alerts
analyser = Analyser(store, fleet, alerts)


def user(request, role="viewer"):
    return auth.require(store, request, role)
