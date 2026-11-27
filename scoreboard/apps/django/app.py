import sys
from django.conf import settings
from django.http import HttpResponse, HttpResponseRedirect
from django.urls import path
from django.views.decorators.csrf import csrf_exempt

settings.configure(DEBUG=False, SECRET_KEY='sample', ALLOWED_HOSTS=['*'], ROOT_URLCONF=__name__)

def home(r): return HttpResponse('<!doctype html><title>Sample</title><h1>Sample app</h1><p><a href="/about">About</a></p><form method="post" action="/signup"><input name="email" type="email" value="a@b.c"><button>Sign up</button></form>')
def about(r): return HttpResponse('<h1>About</h1>')

@csrf_exempt
def signup(r): return HttpResponseRedirect('/', status=303) if r.method == 'POST' else HttpResponse('Sign up')

urlpatterns = [path('', home), path('about', about), path('signup', signup)]

if __name__ == '__main__':
    from django.core.management import execute_from_command_line
    execute_from_command_line(sys.argv)
