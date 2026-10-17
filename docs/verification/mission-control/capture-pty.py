import os,pty,fcntl,termios,struct,select,time,signal,sys
label,command,cols,rows=sys.argv[1:5]; cols=int(cols); rows=int(rows)
pid,fd=pty.fork()
if pid==0:
 os.environ.pop('NO_COLOR',None); os.environ.pop('FORCE_COLOR',None); os.environ['TERM']='xterm-256color'; os.environ['COLORTERM']='truecolor'
 os.execvp(command,[command]+sys.argv[5:])
fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',rows,cols,0,0))
data=b''
def read(seconds):
 global data
 end=time.time()+seconds
 while time.time()<end:
  if select.select([fd],[],[],0.05)[0]:
   try: data+=os.read(fd,65536)
   except OSError: break
def capture(suffix=''):
 open('docs/verification/mission-control/'+label+suffix+'.ansi','wb').write(data)
def send(key):
 os.write(fd,key);read(.4)
read(9);capture()
for suffix,key in [('models',b'5'),('model-next',b'\x1b[B'),('model-pin',b'\r'),('evidence',b'6'),('home',b'1'),('timeline',b'\t'),('approvals',b'\t'),('worktrees',b'\t'),('reverse',b'\x1b[Z'),('inspect-home',b'1'),('inspect',b'\r')]:
 send(key);capture('-'+suffix)
send(b'\x1b');send(b'1')
for key in b'!printf mission-shell-verified': send(bytes([key]))
send(b'\r');read(1);capture('-shell')
send(b'\x03');read(1)
try: os.kill(pid,signal.SIGTERM)
except ProcessLookupError: pass
os.waitpid(pid,0)
print('Captured',label)
