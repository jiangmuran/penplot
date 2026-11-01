# -*- coding: utf-8 -*-
"""Cloudflare Tunnel: real client IP, HTTPS detection, remote principals."""
import pytest

from penplot.web.auth import Principal, client_ip, is_https, mark_remote, via_tunnel
from penplot.web.errors import ApiError


class Req:
    def __init__(self, host, headers):
        self.client = type('C', (), {'host': host})()
        self.headers = {k.lower(): v for k, v in headers.items()}


class Cfg:
    tls_cert = None


def test_cf_header_trusted_only_from_loopback():
    assert via_tunnel({'cf-connecting-ip': '1.2.3.4'}, '127.0.0.1')
    assert not via_tunnel({'cf-connecting-ip': '1.2.3.4'}, '192.168.1.77')   # forged on the LAN
    assert not via_tunnel({}, '127.0.0.1')                                     # local curl
    assert client_ip(Req('127.0.0.1', {'CF-Connecting-IP': '203.0.113.9'})) == '203.0.113.9'
    assert client_ip(Req('192.168.1.77', {'CF-Connecting-IP': '203.0.113.9'})) == '192.168.1.77'


def test_https_detection_for_secure_cookie():
    assert is_https(Req('127.0.0.1', {'X-Forwarded-Proto': 'https'}), Cfg())
    assert not is_https(Req('192.168.1.77', {'X-Forwarded-Proto': 'https'}), Cfg())
    assert not is_https(Req('127.0.0.1', {}), Cfg())


def test_remote_admin_cannot_use_terminal():
    from penplot.web.teletype.service import TeletypeService
    p = Principal('session', 'x', ('read', 'control', 'admin'), role='admin', username='a')
    mark_remote(p, {'cf-connecting-ip': '203.0.113.9'}, '127.0.0.1')
    assert p.extra['remote'] is True

    class T(TeletypeService):
        def __init__(self):
            pass

        def settings(self):
            return {'terminal_enabled': True}
    with pytest.raises(ApiError) as e:
        T()._check_terminal(p)
    assert e.value.code == 'terminal_remote'
    lan = Principal('session', 'y', ('read', 'control', 'admin'), role='admin', username='a')
    mark_remote(lan, {}, '192.168.1.77')
    T()._check_terminal(lan)          # LAN admin: allowed
