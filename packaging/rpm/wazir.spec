Name:           wazir
Version:        0.1.64
Release:        1%{?dist}
Summary:        Autonomous multi-agent AI coding harness and resource-governed fleet orchestrator
License:        AGPL-3.0-or-later
URL:            https://github.com/whassan007/wazir
Source0:        wazir-%{version}.tar.gz
BuildArch:      noarch

Requires:       nodejs >= 22.5.0
Requires:       git

%description
Wazir is a cross-platform, resource-governed autonomous agent orchestration platform.
It enables scalable AI coding execution across local nodes, edge devices, and compute fleets,
featuring intelligent resource admission, multi-process memory management, and deterministic recovery.

%prep
%setup -q

%build
# Bundle is pre-compiled

%install
rm -rf %{buildroot}
mkdir -p %{buildroot}%{_bindir}
mkdir -p %{buildroot}%{_prefix}/lib/wazir
mkdir -p %{buildroot}%{_unitdir}
mkdir -p %{buildroot}%{_localstatedir}/lib/wazir
mkdir -p %{buildroot}%{_localstatedir}/log/wazir

# Install CLI bundle and launcher
install -m 0755 bin/wa.js %{buildroot}%{_prefix}/lib/wazir/wa.js
install -m 0644 package.json %{buildroot}%{_prefix}/lib/wazir/package.json

cat << 'EOF' > %{buildroot}%{_bindir}/wa
#!/bin/sh
exec node /usr/lib/wazir/wa.js "$@"
EOF
chmod 0755 %{buildroot}%{_bindir}/wa

# Install systemd service files
install -m 0644 scripts/systemd/wazir-api.service %{buildroot}%{_unitdir}/wazir-api.service
install -m 0644 scripts/systemd/wazir-worker.service %{buildroot}%{_unitdir}/wazir-worker.service

%pre
if ! getent group wazir >/dev/null 2>&1; then
    groupadd -r wazir
fi
if ! getent passwd wazir >/dev/null 2>&1; then
    useradd -r -g wazir -d %{_localstatedir}/lib/wazir -s /sbin/nologin -c "Wazir Service Daemon" wazir
fi

%post
%systemd_post wazir-api.service wazir-worker.service

%preun
%systemd_preun wazir-api.service wazir-worker.service

%postun
%systemd_postun_with_restart wazir-api.service wazir-worker.service

%files
%license LICENSE
%doc README.md
%{_bindir}/wa
%{_prefix}/lib/wazir
%{_unitdir}/wazir-api.service
%{_unitdir}/wazir-worker.service
%attr(0750, wazir, wazir) %dir %{_localstatedir}/lib/wazir
%attr(0750, wazir, wazir) %dir %{_localstatedir}/log/wazir

%changelog
* Tue Oct 13 2026 Wazir Contributors <wazir@wazir.ai> - 0.1.61-1
- Protocol authorization, policy-enforced tool execution and evidence-based completion

* Mon Oct 12 2026 Wazir Contributors <wazir@wazir.ai> - 0.1.60-1
- Cross-platform fleet execution and expanded package distribution
