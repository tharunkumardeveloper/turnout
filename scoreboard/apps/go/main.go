package main

import (
	"fmt"
	"net/http"
)

func main() {
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		fmt.Fprint(w, `<!doctype html><title>Sample</title><h1>Sample app</h1><p><a href="/about">About</a></p><form method="post" action="/signup"><input name="email" type="email" value="a@b.c"><button>Sign up</button></form>`)
	})
	http.HandleFunc("/about", func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "<h1>About</h1>") })
	http.HandleFunc("/signup", func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, "/", http.StatusSeeOther) })
	fmt.Println("listening on port 8080")
	http.ListenAndServe(":8080", nil)
}
