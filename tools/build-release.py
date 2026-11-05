"""Build dependency-free source releases from a clean, committed checkout.

Python is required only by maintainers building archives, not by the Node service.
"""
import argparse
import hashlib
import json
import posixpath
import re
import subprocess
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parent.parent
DIRECTORIES = {'src', 'web', 'tools', 'docs', 'openapi', 'examples', 'test', 'adapters'}
ROOT_FILES = {'package.json', 'package-lock.json', 'README.md', 'CONTEXT.md',
              'PROTOCOL.md', 'LICENSE', 'LICENSE.md', 'install.cmd', 'init.cmd', 'start.cmd'}
GUIDE = 'docs/安装与接入手册.md'
ADAPTER_FILES = ('index.js', 'plugin.json', 'settings-ui.js', 'memory-page.js', 'protocol-v1.mjs', 'service-start.mjs')


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT).decode('utf-8').strip()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def guide_links(data, commit=None):
    text = data.decode('utf-8-sig')
    def replace(match):
        target = match.group(1)
        if re.match(r'^[a-zA-Z][a-zA-Z0-9+.-]*:|^[/#]', target):
            return match.group(0)
        file, marker, anchor = target.partition('#')
        normalized = posixpath.normpath(posixpath.join('docs', file))
        if normalized.startswith('../'):
            raise ValueError('Guide link leaves release root: ' + target)
        result = normalized
        if commit:
            result = 'https://github.com/LinFom/vec-memory/blob/' + commit + '/' + quote(normalized)
        return '](' + result + (marker + anchor if marker else '') + ')'
    return re.sub(r'\]\(([^)]+)\)', replace, text).encode('utf-8')


def archive(destination, prefix, payload, metadata, timestamp):
    manifest = {**metadata, 'files': [
        {'path': name, 'bytes': len(data), 'sha256': digest(data)}
        for name, data in sorted(payload.items())]}
    payload = {**payload, 'release-manifest.json':
               (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode('utf-8')}
    with zipfile.ZipFile(destination, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for name, data in sorted(payload.items()):
            info = zipfile.ZipInfo(prefix + '/' + name, timestamp)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            z.writestr(info, data)
    with zipfile.ZipFile(destination) as z:
        if z.testzip() is not None:
            raise ValueError('Archive CRC verification failed')
        for row in manifest['files']:
            if digest(z.read(prefix + '/' + row['path'])) != row['sha256']:
                raise ValueError('Archive manifest verification failed: ' + row['path'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    if git('status', '--porcelain'):
        raise SystemExit('Commit reviewed changes before building a release.')
    commit = git('rev-parse', 'HEAD')
    version = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version']
    if not re.fullmatch(r'\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?', version):
        raise SystemExit('Invalid package version')
    tracked = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode('utf-8').split('\0')
    names = [n for n in tracked if n and (n in ROOT_FILES or n.split('/')[0] in DIRECTORIES)]
    for name in names:
        if (ROOT / name).is_symlink():
            raise SystemExit('Symlink cannot be released: ' + name)
    required = {GUIDE, 'package.json', 'package-lock.json', 'src/standalone/server.mjs',
                'src/standalone/worker.mjs', 'web/standalone.html', 'tools/standalone-server.mjs'}
    if not required.issubset(names):
        raise SystemExit('Missing required release files: ' + str(required - set(names)))
    payload = {n: (ROOT / n).read_bytes() for n in names}
    payload['安装与接入手册.md'] = guide_links(payload[GUIDE])
    metadata = {'format': 'vec-memory-source-release', 'version': version,
                'sourceCommit': commit, 'protocolVersion': 1,
                'nodeRequirement': '>=22.5', 'bundledDependencies': False,
                'bundledRuntime': False, 'containsPersonalData': False,
                'installCommand': 'npm ci'}
    instant = datetime.fromtimestamp(int(git('show', '-s', '--format=%ct', 'HEAD')), timezone.utc)
    timestamp = (max(1980, instant.year), instant.month, instant.day,
                 instant.hour, instant.minute, instant.second // 2 * 2)
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    service = out / f'vec-memory-{version}.zip'
    adapter = out / f'vec-memory-qq-adapter-{version}.zip'
    sharing = out / f'vec-memory-{version}-share.zip'
    guide = out / '安装与接入手册.md'
    sums = out / 'SHA256SUMS.txt'
    if any(p.exists() for p in (service, adapter, sharing, guide, sums)):
        raise SystemExit('Refusing to overwrite existing release artifacts')
    archive(service, f'vec-memory-{version}', payload, metadata, timestamp)
    adapter_payload = {name: (ROOT / 'adapters/qq-agent' / name).read_bytes() for name in ADAPTER_FILES}
    adapter_payload['README.md'] = (
        '# QQ-Agent adapter ' + version + '\n\n'
        'Install memory-vec/ in the compatible host plugins/ directory.\n'
        'Configure protocolV1=true, serviceBaseURL=http://127.0.0.1:8091, '
        'spaceId and the PROJECT serviceToken in host settings.\n'
        'Defaults retain legacy compatibility; configuration is required.\n'
        'The service must be installed and started separately.\n\n'
        '中文完整手册：https://github.com/LinFom/vec-memory/blob/' + commit + '/'
        + quote(GUIDE) + '\n').encode('utf-8')
    archive(adapter, 'memory-vec', adapter_payload,
            {**metadata, 'format': 'vec-memory-qq-adapter-release'}, timestamp)
    guide.write_bytes(guide_links(payload[GUIDE], commit))
    share_payload = {
        service.name: service.read_bytes(), adapter.name: adapter.read_bytes(),
        '安装与接入手册.md': guide_links(payload[GUIDE]),
        '完整设计文档.md': guide_links(payload['docs/完整设计文档.md']),
        '项目客观评估.md': guide_links(payload['docs/项目客观评估.md']),
        '00-先读我.md': (
            '# vec-memory ' + version + ' 分享包\n\n'
            '直接使用：解压 vec-memory-' + version + '.zip，先阅读“安装与接入手册.md”。\n'
            'Windows 用户依次运行 install.cmd、init.cmd（仅新库）、start.cmd。\n'
            '本机默认免凭据：服务只监听回环地址，浏览器打开 /standalone.html 直接可用管理页；\n'
            '要恢复“必须给凭据”，用 --require-auth 启动（管理员凭据在 init 时打印过一次，也可在数据目录重置）。\n'
            '需要自行安装 Node.js >=22.5，首次 npm ci 需要联网。本包不含 Node、依赖、模型或个人记忆。\n'
            '升级已有实例时保留原数据目录，不要重新初始化；先做备份。\n\n'
            'QQ-Agent：另外的适配器压缩包只包含插件，必须先启动服务，再按手册配置项目凭据与空间。\n\n'
            '学习参考：阅读完整设计文档、项目客观评估及 docs/；协议在 openapi/，接入代码在 examples/。\n'
            '服务源码和全部测试在主发行包中。文档可离线阅读，仓库链接需要联网。\n\n'
            '公开仓库：https://github.com/LinFom/vec-memory\n'
            '源码提交：' + commit + '\n'
            'release-manifest.json 提供逐文件 SHA-256；SHA256SUMS.txt 用于核对内层包与三份主要文档。\n'
        ).encode('utf-8'),
    }
    share_payload['SHA256SUMS.txt'] = ''.join(
        digest(data) + '  ' + name + '\n' for name, data in sorted(share_payload.items())
        if name.endswith('.zip') or name in ('安装与接入手册.md', '完整设计文档.md', '项目客观评估.md')
    ).encode('utf-8')
    share_payload.update({n: data for n, data in payload.items()
                          if n.split('/')[0] in ('docs', 'openapi', 'examples')})
    archive(sharing, f'vec-memory-{version}-share', share_payload,
            {**metadata, 'format': 'vec-memory-sharing-release'}, timestamp)
    sums.write_text(''.join(digest(p.read_bytes()) + '  ' + p.name + '\n'
                            for p in (service, adapter, sharing, guide)), encoding='utf-8')
    print(json.dumps({'version': version, 'sourceCommit': commit, 'artifacts': [
        {'file': str(p), 'bytes': p.stat().st_size, 'sha256': digest(p.read_bytes())}
        for p in (service, adapter, sharing, guide, sums)]}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
