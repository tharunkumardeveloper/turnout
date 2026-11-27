from flask import Flask, redirect
app = Flask(__name__)

@app.get('/')
def home(): return '<!doctype html><title>Sample</title><h1>Sample app</h1><p><a href="/about">About</a></p><form method="post" action="/signup"><input name="email" type="email" value="a@b.c"><button>Sign up</button></form>'

@app.get('/about')
def about(): return '<h1>About</h1>'

@app.post('/signup')
def signup(): return redirect('/', 303)
