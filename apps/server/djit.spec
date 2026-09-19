from PyInstaller.utils.hooks import collect_dynamic_libs

block_cipher = None
essentia_binaries = collect_dynamic_libs('essentia')
sdl2 = next(path for path, _ in essentia_binaries if path.endswith('/libSDL2-2.0.0.dylib'))

a = Analysis(
    ['djit/desktop_server.py'],
    pathex=[],
    # SDL 1.2 loads SDL2 from its own directory at runtime.
    binaries=essentia_binaries + [(sdl2, '.')],
    datas=[('djit/static', 'djit/static')],
    hiddenimports=[
        'mutagen',
        'librosa',
        'soundfile',
        'numba',
        'essentia',
        'essentia.standard',
        'tkinter',
        'alembic',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)
exe = EXE(
    pyz,
    a.scripts,
    [],
    name='djit-server',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    exclude_binaries=True,
)

bundle = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    name='djit-server',
)
