import QtQuick
import QtQuick.Layouts
import org.kde.plasma.plasmoid
import org.kde.plasma.components as PlasmaComponents
import org.kde.kirigami as Kirigami

PlasmoidItem {
    id: root
    property string fleetState: "offline"
    property int activeWorkers: 0
    property int loadedModels: 0
    property int pendingApprovals: 0

    Plasmoid.status: PlasmaComponents.ToolButton ? Kirigami.Theme.ActiveStatus : 0
    preferredRepresentation: compactRepresentation

    function pollFleet() {
        var xhr = new XMLHttpRequest();
        xhr.onreadystatechange = function() {
            if (xhr.readyState === XMLHttpRequest.DONE) {
                if (xhr.status === 200) {
                    try {
                        var data = JSON.parse(xhr.responseText);
                        root.fleetState = "online";
                        root.activeWorkers = (data.workers && data.workers.length) ? data.workers.length : (data.activeWorkers || 0);
                        root.loadedModels = (data.models && data.models.length) ? data.models.length : (data.loadedModels || 0);
                        root.pendingApprovals = data.pendingApprovals || 0;
                    } catch (e) {
                        root.fleetState = "degraded";
                    }
                } else {
                    root.fleetState = "offline";
                }
            }
        };
        xhr.open("GET", "http://127.0.0.1:4800/health");
        xhr.timeout = 1500;
        xhr.send();
    }

    Timer {
        interval: 5000
        running: true
        repeat: true
        triggeredOnStart: true
        onTriggered: root.pollFleet()
    }

    compactRepresentation: MouseArea {
        implicitWidth: row.implicitWidth + Kirigami.Units.smallSpacing * 2
        implicitHeight: Kirigami.Units.gridUnit * 1.4
        onClicked: root.expanded = !root.expanded

        RowLayout {
            id: row
            anchors.centerIn: parent
            spacing: 6

            Rectangle {
                width: 8
                height: 8
                radius: 4
                color: root.fleetState === "online" ? "#22c55e" : (root.fleetState === "degraded" ? "#eab308" : "#94a3b8")
            }

            PlasmaComponents.Label {
                text: root.fleetState === "online"
                    ? ("Wazir: " + root.activeWorkers + "W / " + root.loadedModels + "M")
                    : "Wazir Offline"
                font.pixelSize: 12
            }
        }
    }

    fullRepresentation: ColumnLayout {
        Layout.minimumWidth: 260
        Layout.minimumHeight: 140
        spacing: 8

        PlasmaComponents.Label {
            text: "Wazir — A Local AI Fleet Counselor"
            font.bold: true
        }
        PlasmaComponents.Label {
            text: "Status: " + root.fleetState.toUpperCase()
        }
        PlasmaComponents.Label {
            text: "Workers: " + root.activeWorkers + " | Models: " + root.loadedModels + " | Approvals: " + root.pendingApprovals
        }
        PlasmaComponents.Button {
            text: "Open Wazir Desktop"
            icon.name: "wazir"
            onClicked: Qt.openUrlExternally("http://127.0.0.1:4801")
        }
    }
}
