import QtQuick 2.15
import QtQuick.Layouts 1.15
import QtQuick.Controls 2.15
import SddmComponents 2.0

Rectangle {
    id: root
    width: 1920
    height: 1080
    color: "#0f131a"

    property int sessionIndex: sessionModel.lastIndex >= 0 ? sessionModel.lastIndex : 0
    property int userIndex: userModel.lastIndex >= 0 ? userModel.lastIndex : 0

    ColumnLayout {
        anchors.centerIn: parent
        width: 360
        spacing: 16

        Image {
            Layout.alignment: Qt.AlignHCenter
            source: "/usr/share/pixmaps/wazir-emblem.png"
            sourceSize.width: 96
            sourceSize.height: 96
            fillMode: Image.PreserveAspectFit
        }

        Text {
            Layout.alignment: Qt.AlignHCenter
            text: "WAZIR"
            color: "#f8fafc"
            font.family: "Inter"
            font.pixelSize: 22
            font.bold: true
            font.letterSpacing: 4
        }

        Text {
            Layout.alignment: Qt.AlignHCenter
            text: "A Local AI Fleet Counselor"
            color: "#94a3b8"
            font.family: "Inter"
            font.pixelSize: 11
            font.letterSpacing: 1.5
        }

        Rectangle {
            Layout.fillWidth: true
            implicitHeight: cardCol.implicitHeight + 32
            radius: 12
            color: "#162032"
            border.color: "#2f4469"
            border.width: 1

            ColumnLayout {
                id: cardCol
                anchors.fill: parent
                anchors.margins: 16
                spacing: 12

                ComboBox {
                    id: userCombo
                    Layout.fillWidth: true
                    model: userModel
                    textRole: "name"
                    currentIndex: root.userIndex
                }

                TextField {
                    id: passwordField
                    Layout.fillWidth: true
                    placeholderText: "Password"
                    echoMode: TextInput.Password
                    color: "#f8fafc"
                    focus: true
                    onAccepted: sddm.login(userCombo.currentText, passwordField.text, sessionCombo.currentIndex)
                }

                ComboBox {
                    id: sessionCombo
                    Layout.fillWidth: true
                    model: sessionModel
                    textRole: "name"
                    currentIndex: root.sessionIndex
                }

                Button {
                    Layout.fillWidth: true
                    text: "Sign In"
                    onClicked: sddm.login(userCombo.currentText, passwordField.text, sessionCombo.currentIndex)
                }

                Text {
                    id: errorLabel
                    Layout.fillWidth: true
                    color: "#ef4444"
                    font.pixelSize: 12
                    horizontalAlignment: Text.AlignHCenter
                    text: ""
                }
            }
        }
    }

    Connections {
        target: sddm
        function onLoginFailed() {
            errorLabel.text = "Authentication failed. Please try again.";
            passwordField.text = "";
            passwordField.focus = true;
        }
    }
}
