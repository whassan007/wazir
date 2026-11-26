// Wazir OS Native Plasma 6 Desktop Layout
// Top persistent macOS-style menu bar + bottom centered floating dock.
// Uses only native KDE Plasma 6 applets so OS updates never break the shell.

var desktop = desktops();
for (var i = 0; i < desktop.length; i++) {
    desktop[i].wallpaperPlugin = "org.kde.image";
    desktop[i].currentConfigGroup = ["Wallpaper", "org.kde.image", "General"];
    desktop[i].writeConfig("Image", "/usr/share/wallpapers/WazirAbyss/contents/images/2816x1536.svg");
}

// 1. Persistent Top Menu Bar (28px, full width, macOS-style)
var topBar = new Panel("org.kde.panel");
topBar.location = "top";
topBar.height = 28;
topBar.floating = false;
topBar.hiding = "none";
topBar.lengthMode = "fill";

var launcher = topBar.addWidget("org.kde.plasma.kickoff");
launcher.currentConfigGroup = ["General"];
launcher.writeConfig("icon", "wazir");
launcher.writeConfig("alphaSort", true);

var appMenu = topBar.addWidget("org.kde.plasma.appmenu");
appMenu.currentConfigGroup = ["General"];
appMenu.writeConfig("compactView", false);

topBar.addWidget("org.kde.plasma.panelspacer");

var fleetWidget = topBar.addWidget("org.wazir.fleet");

var systemTray = topBar.addWidget("org.kde.plasma.systemtray");
var clock = topBar.addWidget("org.kde.plasma.digitalclock");
clock.currentConfigGroup = ["Appearance"];
clock.writeConfig("showDate", true);
clock.writeConfig("dateFormat", "custom");
clock.writeConfig("customDateFormat", "ddd MMM d");
clock.writeConfig("use24hFormat", 0);

// 2. Centered Floating Dock (auto-dodge, pinned developer launchers + running indicators)
var dock = new Panel("org.kde.panel");
dock.location = "bottom";
dock.height = 54;
dock.floating = true;
dock.hiding = "dodgewindows";
dock.lengthMode = "fit";
dock.alignment = "center";

var tasks = dock.addWidget("org.kde.plasma.icontasks");
tasks.currentConfigGroup = ["General"];
tasks.writeConfig("launchers", [
    "applications:org.kde.dolphin.desktop",
    "applications:wazir-terminal.desktop",
    "applications:wazir-desktop.desktop",
    "applications:wazir-mission-control.desktop",
    "applications:wazir-approvals.desktop",
    "applications:systemsettings.desktop"
].join(","));
tasks.writeConfig("groupingStrategy", 1);
tasks.writeConfig("middleClickAction", 2);
tasks.writeConfig("wheelEnabled", false);
tasks.writeConfig("showOnlyCurrentDesktop", false);
tasks.writeConfig("showOnlyCurrentScreen", false);
tasks.writeConfig("indicateAudioStreams", true);
tasks.writeConfig("iconSpacing", 2);

var pager = dock.addWidget("org.kde.plasma.pager");
var trash = dock.addWidget("org.kde.plasma.trash");
